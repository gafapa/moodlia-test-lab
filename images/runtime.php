<?php
// Runs when a lab container starts: gives the administrator a random password
// and issues a web service token, so golden images never contain secrets.
// Prints the connection fixture as JSON. Output must be stored with mode 0600.
//
// Usage: php runtime.php <core|moodlia> [role prefix]
//
// A role prefix (for example SRC or TGT) renames the fixture courses to
// <prefix>-<site>-<suffix>, so two sites started from the same image never share
// a shortname when one synchronizes into the other.

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->libdir . '/externallib.php');
require_once($CFG->libdir . '/gradelib.php');

$provider = $argv[1] ?? '';
if (!in_array($provider, ['core', 'moodlia'], true)) {
    fwrite(STDERR, "Usage: runtime.php <core|moodlia> [role prefix]\n");
    exit(2);
}
$prefix = $argv[2] ?? '';
if ($prefix !== '' && !preg_match('/^[A-Z]{1,8}$/', $prefix)) {
    fwrite(STDERR, "The role prefix must be 1 to 8 uppercase letters.\n");
    exit(2);
}

global $DB;
// Moodle creates missing contexts from cron, which lab sites do not run. A module without a
// context made parallel read-only calls race to insert it (UNIQUE constraint on mdl_context).
\context_helper::create_instances();
\context_helper::build_all_paths(false);
// SQLite accepts one writer at a time, and the standard log store inserts a row on every web
// service call, so concurrent read-only calls failed with dml_write_exception. Lab sites on
// SQLite keep no logs; PostgreSQL sites keep them.
if ($DB->get_dbfamily() === 'sqlite') {
    set_config('enabled_stores', '', 'tool_log');
    // Moodle's SQLite driver keeps the rollback journal, where a request that reads and then
    // writes fails at once while another request writes. WAL lets reads proceed during a
    // write; the mode is stored in the database file.
    try {
        $wal = new PDO('sqlite:' . $DB->get_dbfilepath());
        $wal->exec('PRAGMA busy_timeout=10000');
        $mode = $wal->query('PRAGMA journal_mode=WAL')->fetchColumn();
        if ($mode !== 'wal') {
            fwrite(STDERR, "SQLite journal mode is {$mode}, not wal.\n");
        }
        $wal = null;
    } catch (\Throwable $error) {
        fwrite(STDERR, 'Unable to enable SQLite WAL: ' . $error->getMessage() . "\n");
    }
}
$admin = get_admin();
\core\session\manager::set_user($admin);
update_internal_user_password($admin, bin2hex(random_bytes(24)));

$shortname = $provider === 'core' ? 'moodlia_lab_core' : 'local_moodlia';
$service = $DB->get_record('external_services', ['shortname' => $shortname], '*', MUST_EXIST);
if (!$DB->record_exists('external_services_users', ['externalserviceid' => $service->id, 'userid' => $admin->id])) {
    $DB->insert_record('external_services_users', (object) [
        'externalserviceid' => $service->id,
        'userid' => $admin->id,
        'iprestriction' => '',
        'validuntil' => 0,
        'timecreated' => time(),
    ]);
}
$arguments = [EXTERNAL_TOKEN_PERMANENT, $service, (int) $admin->id, \context_system::instance(), 0, ''];
$token = class_exists('core_external\\util') && method_exists('core_external\\util', 'generate_token')
    ? \core_external\util::generate_token(...$arguments)
    : external_generate_token(...$arguments);

// fixture.php names its courses after the site; a synchronized target may hold other sites' names too.
$site = 'M' . $CFG->branch . strtoupper($provider);
$courses = [];
$name = $prefix === '' ? $site : "{$prefix}-{$site}";
foreach (['SOURCE', 'TARGET-A', 'TARGET-B'] as $suffix) {
    $id = $DB->get_field('course', 'id', ['shortname' => "{$name}-{$suffix}"])
        ?: $DB->get_field('course', 'id', ['shortname' => "{$site}-{$suffix}"]);
    if ($id && $name !== $site) {
        $DB->set_field('course', 'shortname', "{$name}-{$suffix}", ['id' => $id]);
        rebuild_course_cache((int) $id, true);
    }
    if ($id) {
        // Images built before fixture.php did this lack the course grade category and item; see there.
        grade_category::fetch_course_category((int) $id);
        grade_item::fetch_course_item((int) $id);
    }
    $courses['LAB-' . $suffix] = $id;
}
echo json_encode([
    'provider' => $provider,
    'token' => $token,
    'moodle_release' => $CFG->release,
    'plugin_version' => get_config('local_moodlia', 'version') ?: null,
    'source_course_id' => (int) ($courses['LAB-SOURCE'] ?? 0),
    'target_course_ids' => [(int) ($courses['LAB-TARGET-A'] ?? 0), (int) ($courses['LAB-TARGET-B'] ?? 0)],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
