<?php
// Runs when a lab container starts: gives the administrator a random password
// and issues a web service token, so golden images never contain secrets.
// Prints the connection fixture as JSON. Output must be stored with mode 0600.
//
// Usage: php runtime.php <core|moodlia>

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->libdir . '/externallib.php');

$provider = $argv[1] ?? '';
if (!in_array($provider, ['core', 'moodlia'], true)) {
    fwrite(STDERR, "Usage: runtime.php <core|moodlia>\n");
    exit(2);
}

global $DB;
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

$courses = $DB->get_records_menu('course', null, '', 'shortname, id');
echo json_encode([
    'provider' => $provider,
    'token' => $token,
    'moodle_release' => $CFG->release,
    'plugin_version' => get_config('local_moodlia', 'version') ?: null,
    'source_course_id' => (int) ($courses['LAB-SOURCE'] ?? 0),
    'target_course_ids' => [(int) ($courses['LAB-TARGET-A'] ?? 0), (int) ($courses['LAB-TARGET-B'] ?? 0)],
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
