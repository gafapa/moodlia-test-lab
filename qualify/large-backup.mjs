// Large-backup scenario: exercises streamed uploads and downloads above the
// old 50/100 MiB client limits against a MoodlIA lab site.
//
// usage: node large-backup.mjs <fixture.json> <site-url> <report.json> [size-mib]
// Runs from a directory where the moodlia package is installed.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createMoodleClient } from 'moodlia';

const [fixturePath, siteUrl, reportPath, sizeArgument] = process.argv.slice(2);
const sizeMiB = Number(sizeArgument ?? 120);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const contract = createRequire(import.meta.url)('moodlia/contract');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moodlia-large-backup-'));
let peakBytes = 0;
const sample = () => {
  const usage = process.memoryUsage();
  peakBytes = Math.max(peakBytes, usage.heapUsed + usage.arrayBuffers);
};
const sampler = setInterval(sample, 50);

async function writeRandomFile(filePath, mib) {
  const handle = await fs.promises.open(filePath, 'w');
  const hash = createHash('sha256');
  for (let index = 0; index < mib; index += 1) {
    const chunk = randomBytes(1024 * 1024); // incompressible, so the .mbz stays large
    hash.update(chunk);
    await handle.write(chunk);
  }
  await handle.close();
  return hash.digest('hex');
}

try {
  const client = createMoodleClient({
    baseUrl: siteUrl,
    token: fixture.token,
    contract,
    allowInsecure: true,
    timeoutMs: 600_000,
    uploadTimeoutMs: 600_000,
    maximumDownloadBytes: 2 * 1024 * 1024 * 1024
  });
  const courseId = fixture.source_course_id;
  const sourcePath = path.join(work, 'large-resource.bin');
  const sourceHash = await writeRandomFile(sourcePath, sizeMiB);
  const baseline = process.memoryUsage().heapUsed;

  const draft = await client.uploadDraftFile(sourcePath, { filename: 'large-resource.bin' });
  await client.callOperation('create_module', {
    course_id: courseId,
    section_number: 1,
    module_type: 'resource',
    name: 'Large resource',
    options: { filename: 'large-resource.bin', draft_item_id: draft.draft_item_id }
  });

  const backup = await client.callOperation('backup_course', { course_id: courseId, include_users: false });
  const backupPath = path.join(work, backup.filename);
  const downloaded = await client.downloadFileToPath(backup.url, backupPath, { maximumBytes: 2 * 1024 * 1024 * 1024 });

  const backupDraft = await client.uploadDraftFile(backupPath, { filename: backup.filename });
  const uploaded = await client.callOperation('upload_course_backup', {
    filename: backup.filename,
    draft_item_id: backupDraft.draft_item_id
  });
  const restored = await client.callOperation('restore_course_backup', {
    backup_file_id: uploaded.file_id,
    target: 'new_course',
    category_id: 1,
    fullname: 'Large backup restore',
    shortname: `LAB-LARGE-${Date.now()}`
  });
  sample();

  const report = {
    resource_bytes: sizeMiB * 1024 * 1024,
    resource_sha256: sourceHash,
    backup_bytes_reported: backup.filesize,
    backup_bytes_downloaded: downloaded.filesize,
    backup_sha256: downloaded.sha256,
    uploaded_backup_bytes: uploaded.filesize,
    restored: restored.restored,
    restored_course_id: restored.course_id,
    peak_client_memory_mib: Math.round((peakBytes - baseline) / 1024 / 1024)
  };
  const failures = [];
  if (backup.filesize < 100 * 1024 * 1024) failures.push('backup is not larger than 100 MiB');
  if (downloaded.filesize !== backup.filesize) failures.push('downloaded size differs from the reported size');
  if (uploaded.filesize !== downloaded.filesize) failures.push('uploaded backup size differs from the download');
  if (!restored.restored) failures.push('restore did not complete');
  if (report.peak_client_memory_mib > 128) failures.push('the client buffered the transfer in memory');
  report.failures = failures;
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  clearInterval(sampler);
  fs.rmSync(work, { recursive: true, force: true });
}
