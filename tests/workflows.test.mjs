import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('every supported Moodle branch has a base image tag', () => {
  const versions = JSON.parse(read('images/versions.json'));
  assert.deepEqual(Object.keys(versions), ['4.5', '5.0', '5.1', '5.2', '5.3']);
  for (const tag of Object.values(versions)) assert.match(tag, /^v\d+\.\d+\.\d+/);
});

test('golden images never bake secrets and runtime issues them', () => {
  const build = read('images/build.sh');
  const runtime = read('images/runtime.php');
  assert.match(build, /MOODLE_PASSWORD=build-\$\(openssl rand/);
  assert.doesNotMatch(read('images/fixture.php'), /generate_token/);
  assert.match(runtime, /update_internal_user_password\(\$admin, bin2hex\(random_bytes/);
  assert.match(runtime, /generate_token/);
});

test('the nightly matrix covers every source and target pair and PostgreSQL', () => {
  const nightly = read('.github/workflows/nightly.yml');
  assert.match(nightly, /source: \['4\.5', '5\.0', '5\.1', '5\.2', '5\.3'\]/);
  assert.match(nightly, /target: \['4\.5', '5\.0', '5\.1', '5\.2', '5\.3'\]/);
  assert.match(nightly, /database: pgsql/);
});

test('qualify-live always cleans up and bounds container resources', () => {
  const source = read('qualify/qualify-live.mjs');
  assert.match(source, /\} finally \{\n  cleanup\(\);\n\}/);
  assert.match(source, /'--memory', memory, '--cpus', String\(cpus\)/);
  assert.match(source, /'moodlia-lab=true'/);
});
