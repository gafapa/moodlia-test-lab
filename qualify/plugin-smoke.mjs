// Exercises plugin write features against a live MoodlIA lab site: group
// visibility and keys, text formats, embedded draft files for forum, glossary,
// and Lesson, and downloading a course backup through its pluginfile URL.
//
// usage: node plugin-smoke.mjs <fixture.json> <site-url>
// Runs from a directory where the moodlia package is installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createMoodleClient } from 'moodlia';

const [fixturePath, siteUrl] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const contract = createRequire(import.meta.url)('moodlia/contract');
const client = createMoodleClient({ baseUrl: siteUrl, token: fixture.token, contract, allowInsecure: true });
const courseId = fixture.target_course_ids[0];
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moodlia-plugin-smoke-'));
const results = [];

async function check(name, callback) {
  try {
    await callback();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: `${error.code ?? ''} ${error.message}`.trim(),
      details: error.details?.moodle_debuginfo ?? error.details?.moodle_errorcode ?? null
    });
  }
}

async function draft(filename, content) {
  const filePath = path.join(work, filename);
  fs.writeFileSync(filePath, content);
  return (await client.uploadDraftFile(filePath, { filename })).draft_item_id;
}

async function step(label, callback) {
  try {
    return await callback();
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

async function module(type, name) {
  const created = await step(`create_module ${type}`, () =>
    client.callOperation('create_module', { course_id: courseId, section_number: 1, module_type: type, name }));
  return created.module_id;
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

try {
  let groupId;
  await check('create_group stores visibility, participation, format, and key', async () => {
    const group = await client.callOperation('create_group', {
      course_id: courseId, name: `Smoke ${Date.now()}`, description: '**md**', description_format: 'markdown',
      visibility: 'members', participation: false, enrolment_key: `key-${Date.now()}`
    });
    groupId = group.group_id;
    assert.equal(group.visibility, 'members');
    assert.equal(group.participation, false);
    assert.equal(group.description_format, 'markdown');
    assert.equal(group.has_enrolment_key, true);
    assert.equal('enrolment_key' in group, false);
  });
  await check('update_group changes visibility without members', async () => {
    const updated = await client.callOperation('update_group', { course_id: courseId, group_id: groupId, visibility: 'none' });
    assert.equal(updated.visibility, 'none');
    assert.equal(updated.participation, false);
  });

  await check('forum discussion publishes inline and attachment drafts; reply keeps markdown', async () => {
    const forumId = await module('forum', 'Smoke forum');
    const discussion = await client.callOperation('create_forum_discussion', {
      course_id: courseId, module_id: forumId, name: 'Hola',
      message: '<p><img src="@@PLUGINFILE@@/pixel.png"></p>',
      inline_draft_item_id: await draft('pixel.png', png),
      attachment_draft_item_id: await draft('notes.txt', 'attached')
    });
    const reply = await client.callOperation('create_forum_discussion_post', {
      course_id: courseId, module_id: forumId, discussion_id: discussion.discussion_id,
      subject: 'Re', message: '*reply*', message_format: 'markdown'
    });
    await client.callOperation('update_forum_discussion_post', {
      course_id: courseId, module_id: forumId, discussion_id: discussion.discussion_id,
      post_id: reply.post_id, message: '*edited*'
    });
  });

  await check('book chapters accept format names and legacy constants', async () => {
    const bookId = await module('book', 'Smoke book');
    const named = await step('create_book_chapter markdown', () => client.callOperation('create_book_chapter', {
      course_id: courseId, module_id: bookId, title: 'Named', content: '*md*', content_format: 'markdown'
    }));
    const legacy = await step('create_book_chapter legacy', () => client.callOperation('create_book_chapter', {
      course_id: courseId, module_id: bookId, title: 'Legacy', content: 'plain', content_format: '2'
    }));
    assert.equal(named.content_format, 4);
    assert.equal(legacy.content_format, 2);
  });

  await check('lesson pages publish drafts and accept format names', async () => {
    const lessonId = await module('lesson', 'Smoke lesson');
    const created = await client.callOperation('create_lesson_page', {
      course_id: courseId, module_id: lessonId, title: 'Intro',
      content: '<p><img src="@@PLUGINFILE@@/slide.png"></p>', content_format: 'html',
      branches: '{"branches":[{"title":"Next","jump_to":-1}]}',
      draft_item_id: await draft('slide.png', png)
    });
    await client.callOperation('update_lesson_page', {
      course_id: courseId, module_id: lessonId, page_id: created.page.page_id,
      draft_item_id: await draft('chart.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    });
  });

  await check('glossary entries publish inline drafts', async () => {
    const glossaryId = await module('glossary', 'Smoke glossary');
    await client.callOperation('create_glossary_entry', {
      course_id: courseId, module_id: glossaryId, concept: 'Term', definition: '<p><img src="@@PLUGINFILE@@/term.png"></p>',
      definition_format: 'html', inline_draft_item_id: await draft('term.png', png)
    });
  });

  // Moodle's backup needs temporary tables, which its SQLite driver lacks: backups need --database pgsql.
  if (process.env.LAB_DATABASE === 'sqlite3') {
    results.push({ name: 'course backups download through their pluginfile URL', ok: true, skipped: 'SQLite cannot run Moodle backups' });
  } else await check('course backups download through their pluginfile URL', async () => {
    const backup = await client.callOperation('backup_course', { course_id: courseId, include_users: false });
    const downloaded = await client.downloadFileToPath(backup.url, path.join(work, backup.filename));
    assert.equal(downloaded.filesize, backup.filesize);
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
