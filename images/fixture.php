<?php
// Install-time fixture for a MoodlIA golden lab image. It runs once while the
// image is built and stores no secrets: tokens and the administrator password
// are created at container start by runtime.php.
//
// Usage: php fixture.php <core|moodlia>

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->libdir . '/externallib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/group/lib.php');

$provider = $argv[1] ?? '';
if (!in_array($provider, ['core', 'moodlia'], true)) {
    fwrite(STDERR, "Usage: fixture.php <core|moodlia>\n");
    exit(2);
}

global $DB;
\core\session\manager::set_user(get_admin());
set_config('enablewebservices', 1);
set_config('webserviceprotocols', 'rest');

/**
 * Create the restricted lab service that exposes every Core function.
 */
function lab_core_service(): void {
    global $DB;
    $shortname = 'moodlia_lab_core';
    $service = $DB->get_record('external_services', ['shortname' => $shortname]);
    if (!$service) {
        $now = time();
        $id = $DB->insert_record('external_services', (object) [
            'name' => 'MoodlIA lab Core',
            'enabled' => 1,
            'requiredcapability' => '',
            'restrictedusers' => 1,
            'component' => '',
            'timecreated' => $now,
            'timemodified' => $now,
            'shortname' => $shortname,
            'downloadfiles' => 1,
            'uploadfiles' => 1,
        ]);
        $service = $DB->get_record('external_services', ['id' => $id], '*', MUST_EXIST);
    }
    $registered = $DB->get_records_menu('external_services_functions', ['externalserviceid' => $service->id], '', 'functionname, id');
    foreach ($DB->get_fieldset_select('external_functions', 'name', '1 = 1') as $name) {
        if (!array_key_exists($name, $registered)) {
            $DB->insert_record('external_services_functions', (object) ['externalserviceid' => $service->id, 'functionname' => $name]);
        }
    }
}

/**
 * Create a hidden course with two sections unless it already exists.
 */
function lab_course(string $shortname, string $fullname, string $summary): stdClass {
    global $DB;
    if ($existing = $DB->get_record('course', ['shortname' => $shortname])) {
        return $existing;
    }
    $course = create_course((object) [
        'fullname' => $fullname,
        'shortname' => $shortname,
        'category' => 1,
        'summary' => $summary,
        'summaryformat' => FORMAT_HTML,
        'format' => 'topics',
        'visible' => 0,
        'numsections' => 2,
    ]);
    course_create_sections_if_missing($course, 1);
    return $DB->get_record('course', ['id' => $course->id], '*', MUST_EXIST);
}

/**
 * Add the Unicode group and grouping used by synchronization scenarios.
 */
function lab_groups(stdClass $course): void {
    global $DB;
    if ($DB->record_exists('groups', ['courseid' => $course->id, 'name' => 'Unicode Team á'])) {
        return;
    }
    $groupid = groups_create_group((object) [
        'courseid' => $course->id,
        'name' => 'Unicode Team á',
        'description' => '<p>Portable group description.</p>',
        'descriptionformat' => FORMAT_HTML,
    ]);
    $groupingid = groups_create_grouping((object) [
        'courseid' => $course->id,
        'name' => 'Qualification grouping',
        'description' => '<p>Cross-version grouping.</p>',
        'descriptionformat' => FORMAT_HTML,
    ]);
    groups_assign_grouping($groupingid, $groupid);
}

/**
 * Add a portable Page with a root and a nested Unicode asset through MoodlIA.
 */
function lab_page(stdClass $course): void {
    global $DB, $USER;
    $exists = $DB->record_exists_sql(
        'SELECT 1 FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module '
            . 'JOIN {page} p ON p.id = cm.instance WHERE cm.course = ? AND m.name = ? AND p.name = ?',
        [$course->id, 'page', 'Portable Page á']
    );
    if ($exists) {
        return;
    }
    $draftitemid = file_get_unused_draft_itemid();
    $usercontextid = \context_user::instance((int) $USER->id)->id;
    $storage = get_file_storage();
    $storage->create_file_from_string([
        'contextid' => $usercontextid, 'component' => 'user', 'filearea' => 'draft',
        'itemid' => $draftitemid, 'filepath' => '/', 'filename' => 'hero ünicode.png',
    ], base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', true));
    $storage->create_file_from_string([
        'contextid' => $usercontextid, 'component' => 'user', 'filearea' => 'draft',
        'itemid' => $draftitemid, 'filepath' => '/nested/', 'filename' => 'diagram ünicode.svg',
    ], '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
    \local_moodlia\operation\create_module::execute((int) $course->id, 1, 'page', 'Portable Page á', [
        'content' => '<p>Cross-version portable content.</p>'
            . '<p><img src="@@PLUGINFILE@@/hero%20%C3%BCnicode.png" alt="One pixel"></p>'
            . '<p><img src="@@PLUGINFILE@@/nested/diagram%20%C3%BCnicode.svg" alt="Nested diagram"></p>',
        'filename' => 'hero ünicode.png',
        'draft_item_id' => $draftitemid,
    ]);
}

lab_core_service();
// Shortnames are unique per site, and synchronization copies them: prefix them with the site
// (for example M405CORE-SOURCE) so a source course never collides with a course on the target.
$site = 'M' . $CFG->branch . strtoupper($provider);
$source = lab_course("{$site}-SOURCE", 'Lab source course', '<p>Cross-version summary.</p>');
lab_groups($source);
if ($provider === 'moodlia') {
    lab_page($source);
}
lab_course("{$site}-TARGET-A", 'Lab target A', '<p>Target A placeholder.</p>');
lab_course("{$site}-TARGET-B", 'Lab target B', '<p>Target B placeholder.</p>');

echo json_encode([
    'provider' => $provider,
    'moodle_release' => $CFG->release,
    'plugin_version' => get_config('local_moodlia', 'version') ?: null,
    'source_course_id' => (int) $source->id,
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
