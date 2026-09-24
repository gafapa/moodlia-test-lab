#!/usr/bin/env node
// Runs the four-pairing live synchronization qualification against golden lab
// images and always removes the containers it started.
//
// usage: node qualify/qualify-live.mjs --source 4.5 --target 5.3 --package <moodlia-sync tgz|version>
//          --runner <moodlia-sync/tools/live-qualification/runner> [--image-prefix ghcr.io/gafapa/moodlia-lab]
//          [--run-id <id>] [--memory 768m] [--cpus 0.75] [--keep] [--output results]
//          [--database pgsql --plugin <moodle-local_moodlia checkout>] [--large-backup [size-mib]] [--plugin-smoke]
//
// The default uses SQLite golden images. --database pgsql installs each site
// from the base image against its own PostgreSQL container instead, because
// SQLite is not a production Moodle database and can hide SQL defects.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
for (const required of ['source', 'target', 'package', 'runner']) {
  if (!options[required] || options[required] === true) {
    console.error(`--${required} is required.`);
    process.exit(2);
  }
}
const imagePrefix = options['image-prefix'] ?? 'ghcr.io/gafapa/moodlia-lab';
const database = options.database ?? 'sqlite3';
if (!['sqlite3', 'pgsql'].includes(database)) throw new Error('--database must be sqlite3 or pgsql.');
if (options['large-backup'] && database !== 'pgsql') {
  throw new Error('--large-backup needs --database pgsql: Moodle backups do not run on SQLite.');
}
if (database === 'pgsql' && (!options.plugin || !fs.existsSync(path.join(String(options.plugin), 'version.php')))) {
  throw new Error('--database pgsql needs --plugin with a moodle-local_moodlia checkout.');
}
const baseTags = JSON.parse(fs.readFileSync(path.join(labRoot, 'images', 'versions.json'), 'utf8'));
const memory = options.memory ?? '768m';
const cpus = options.cpus ?? '0.75';
const runId = options['run-id'] ?? `lab-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(runId)) throw new Error('--run-id must be lowercase letters, digits, and dashes.');

// The runner's scenario names use m45* for the source and m53* for the target.
const sites = [
  { slot: 'm45core', version: options.source, variant: 'core', port: 18450 },
  { slot: 'm45plugin', version: options.source, variant: 'moodlia', port: 18451 },
  { slot: 'm53core', version: options.target, variant: 'core', port: 18530 },
  { slot: 'm53plugin', version: options.target, variant: 'moodlia', port: 18531 }
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), `moodlia-lab-${runId}-`));
fs.chmodSync(root, 0o700);
const results = path.join(root, 'results');
const runner = path.join(root, 'runner');
fs.mkdirSync(results, { mode: 0o700 });
fs.mkdirSync(runner, { mode: 0o700 });
const containers = [];
const networks = [];

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function cleanup() {
  if (options.keep) {
    console.error(`Keeping containers ${containers.join(', ')} and ${root}.`);
    return;
  }
  for (const name of containers) docker(['rm', '-f', '-v', name], { allowFailure: true });
  for (const name of networks) docker(['network', 'rm', name], { allowFailure: true });
  fs.rmSync(root, { recursive: true, force: true });
}

async function waitHealthy(name) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = docker(['inspect', '-f', '{{.State.Health.Status}}', name], { allowFailure: true });
    if (status === 'healthy') return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`${name} did not become healthy:\n${docker(['logs', '--tail', '60', name], { allowFailure: true })}`);
}

// Installs a site from the base image against PostgreSQL, then applies the same
// fixture as the golden images.
async function prepareFreshSite(site) {
  const network = `moodlia-lab-${runId}`;
  if (!networks.includes(network)) {
    docker(['network', 'create', network]);
    networks.push(network);
  }
  const password = randomBytes(18).toString('hex');
  const databaseName = `${site.container}-db`;
  docker([
    'run', '-d', '--name', databaseName, '--network', network, '--label', 'moodlia-lab=true',
    '--memory', '384m', '-e', 'POSTGRES_USER=moodle', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=moodle',
    'postgres:16'
  ]);
  containers.push(databaseName);
  return [
    '--network', network,
    '-e', 'DB_TYPE=pgsql', '-e', `DB_HOST=${databaseName}`, '-e', 'DB_NAME=moodle',
    '-e', 'DB_USER=moodle', '-e', `DB_PASS=${password}`,
    '-e', 'MOODLE_USERNAME=admin', '-e', `MOODLE_PASSWORD=${randomBytes(18).toString('hex')}`,
    '-e', 'MOODLE_EMAIL=lab@example.invalid'
  ];
}

async function installFixture(site) {
  const hasPublic = docker(['exec', site.container, 'sh', '-c', 'test -d /var/www/html/public && echo yes || echo no']) === 'yes';
  const localDirectory = hasPublic ? '/var/www/html/public/local' : '/var/www/html/local';
  if (site.variant === 'moodlia') {
    docker(['exec', '-u', 'root', site.container, 'mkdir', '-p', `${localDirectory}/moodlia`]);
    const archive = spawnSync('tar', ['-C', String(options.plugin), '--exclude=.git', '--exclude=node_modules', '-cf', '-', '.'], {
      maxBuffer: 200 * 1024 * 1024
    });
    if (archive.status !== 0) throw new Error('Unable to archive the plugin checkout.');
    const copy = spawnSync('docker', ['exec', '-i', '-u', 'root', site.container, 'tar', '-C', `${localDirectory}/moodlia`, '-xf', '-'], {
      input: archive.stdout
    });
    if (copy.status !== 0) throw new Error(`Unable to copy the plugin into ${site.container}.`);
    docker(['exec', '-u', 'root', site.container, 'chown', '-R', 'nobody:', `${localDirectory}/moodlia`]);
    docker(['exec', site.container, 'php', '/var/www/html/admin/cli/upgrade.php', '--non-interactive', '--allow-unstable']);
  }
  docker(['exec', '-u', 'root', site.container, 'mkdir', '-p', '/opt/moodlia-lab']);
  docker(['cp', path.join(labRoot, 'images', 'fixture.php'), `${site.container}:/opt/moodlia-lab/fixture.php`]);
  docker(['cp', path.join(labRoot, 'images', 'runtime.php'), `${site.container}:/opt/moodlia-lab/runtime.php`]);
  docker(['exec', site.container, 'php', '/opt/moodlia-lab/fixture.php', site.variant]);
}

let exitCode = 1;
try {
  const profiles = { schema_version: 1, profiles: {} };
  for (const site of sites) {
    const name = `moodlia-lab-${runId}-${site.slot}`;
    site.container = name;
    const fresh = database === 'pgsql';
    if (fresh && !baseTags[site.version]) throw new Error(`Unknown Moodle version ${site.version}.`);
    const image = fresh ? `erseco/alpine-moodle:${baseTags[site.version]}` : `${imagePrefix}:${site.version}-${site.variant}`;
    const databaseArguments = fresh ? await prepareFreshSite(site) : ['-e', 'DB_TYPE=sqlite3', '-e', 'MOODLE_DATABASE_TYPE=sqlite3'];
    docker([
      'run', '-d', '--name', name, '--label', 'moodlia-lab=true',
      '--memory', memory, '--cpus', String(cpus),
      '-p', `127.0.0.1:${site.port}:8080`,
      '-e', `SITE_URL=http://127.0.0.1:${site.port}`,
      ...databaseArguments,
      '-e', 'REVERSEPROXY=true', '-e', 'AUTO_UPDATE_MOODLE=true',
      // Large-backup scenarios need more than the image's 50 MiB PHP limits.
      '-e', 'post_max_size=1G', '-e', 'upload_max_filesize=1G',
      image
    ]);
    containers.push(name);
    const tokenEnv = `Q_${site.slot.toUpperCase().replace('M45', 'M45_').replace('M53', 'M53_')}_TOKEN`;
    profiles.profiles[site.slot] = {
      url: `http://127.0.0.1:${site.port}`,
      backend: site.variant === 'core' ? 'core' : 'moodlia',
      allow_insecure: true,
      credentials: { [site.variant === 'core' ? 'core' : 'moodlia']: { token_env: tokenEnv } }
    };
  }
  for (const site of sites) await waitHealthy(site.container);
  if (database === 'pgsql') {
    for (const site of sites) await installFixture(site);
  }
  for (const site of sites) {
    // PHP notices may precede the fixture; runtime.php prints the JSON last.
    const output = docker(['exec', site.container, 'php', '/opt/moodlia-lab/runtime.php', site.variant]);
    const fixture = JSON.parse(output.split(/\r?\n/).at(-1));
    fs.writeFileSync(path.join(results, `${site.slot}.json`), `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(runner, 'profiles.json'), `${JSON.stringify(profiles, null, 2)}\n`);

  for (const file of fs.readdirSync(options.runner).filter((entry) => entry.endsWith('.mjs'))) {
    fs.copyFileSync(path.join(options.runner, file), path.join(runner, file));
  }
  fs.writeFileSync(path.join(runner, 'package.json'), `${JSON.stringify({ name: 'moodlia-lab-runner', private: true, type: 'module' })}\n`);
  const packageSpec = fs.existsSync(options.package) ? path.resolve(options.package) : `moodlia-sync@${options.package}`;
  execFileSync('npm', ['install', '--no-audit', '--no-fund', packageSpec], { cwd: runner, stdio: 'inherit', shell: process.platform === 'win32' });
  execFileSync('npm', ['rebuild', 'better-sqlite3'], { cwd: runner, stdio: 'inherit', shell: process.platform === 'win32' });

  const run = spawnSync(process.execPath, [path.join(runner, 'run-qualification.mjs')], {
    cwd: runner,
    env: { ...process.env, QUALIFICATION_ROOT: root, QUALIFICATION_RUN_ID: runId },
    stdio: 'inherit'
  });
  const reportPath = path.join(results, `${runId}-qualification-report.json`);
  const outputDirectory = path.resolve(options.output ?? 'results');
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (fs.existsSync(reportPath)) {
    fs.copyFileSync(reportPath, path.join(outputDirectory, path.basename(reportPath)));
    console.log(`Report: ${path.join(outputDirectory, path.basename(reportPath))}`);
  }
  if ((run.status ?? 1) !== 0) {
    // Keep plans, CLI output, and sync state for diagnosis. Site fixtures hold tokens and are
    // named after their slot, not the run id, so they are never copied.
    const evidence = path.join(outputDirectory, `${runId}-evidence`);
    fs.mkdirSync(evidence, { recursive: true });
    for (const name of fs.readdirSync(results).filter((entry) => entry.startsWith(`${runId}-`))) {
      fs.copyFileSync(path.join(results, name), path.join(evidence, name));
    }
    console.log(`Failure evidence: ${evidence}`);
  }
  exitCode = run.status ?? 1;
  if (options['plugin-smoke']) {
    // Plugin write features (groups, formats, embedded files, backup download) on the target MoodlIA site.
    fs.copyFileSync(path.join(labRoot, 'qualify', 'plugin-smoke.mjs'), path.join(runner, 'plugin-smoke.mjs'));
    const smoke = spawnSync(process.execPath, [
      path.join(runner, 'plugin-smoke.mjs'),
      path.join(results, 'm53plugin.json'),
      profiles.profiles.m53plugin.url
    ], { cwd: runner, stdio: 'inherit', env: { ...process.env, LAB_DATABASE: database } });
    if ((smoke.status ?? 1) !== 0) exitCode = exitCode || 1;
  }
  if (options['large-backup']) {
    // Streams a >100 MiB backup through upload, backup, download, and restore on the source MoodlIA site.
    fs.copyFileSync(path.join(labRoot, 'qualify', 'large-backup.mjs'), path.join(runner, 'large-backup.mjs'));
    const largeReport = path.join(outputDirectory, `${runId}-large-backup-report.json`);
    const large = spawnSync(process.execPath, [
      path.join(runner, 'large-backup.mjs'),
      path.join(results, 'm45plugin.json'),
      profiles.profiles.m45plugin.url,
      largeReport,
      options['large-backup'] === true ? '120' : String(options['large-backup'])
    ], { cwd: runner, stdio: 'inherit' });
    if ((large.status ?? 1) !== 0) exitCode = exitCode || 1;
  }
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
