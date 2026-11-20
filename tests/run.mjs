import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resultsRoot = join(root, 'test_results');
mkdirSync(resultsRoot, { recursive: true });
const results = mkdtempSync(join(resultsRoot, 'issue-14-'));
const project = `gis-platform-${basename(results).toLowerCase()}`;
const image = 'gis-platform-issue-14-tests';
const mode = process.argv[2];
const containerUser = process.getuid === undefined ? [] : ['--user', `${process.getuid()}:${process.getgid()}`];
const resultsMount = ['--mount', `type=bind,src=${results},dst=/results`];
const stackEnvironment = { COMPOSE_PROJECT_NAME: project, GIS_STATE_DIR: join(results, 'state') };

function run(name, executable, args, env = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(results, `${name}.log`), output);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed (${result.status})\n${output}`);
  return result.stdout;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function cli(name, ...args) {
  const output = run(name, process.execPath, ['dist/cli.js', 'config', ...args, '--json'], stackEnvironment);
  const result = JSON.parse(output);
  assert.equal(result.status, 'ok');
  return result;
}

async function runHttpTests() {
  run('build-host-cli', process.execPath, ['node_modules/typescript/bin/tsc']);
  const port = await freePort();
  const file = join(results, 'platform.yaml');
  copyFileSync(join(root, 'examples/places.geojson'), join(results, 'places.geojson'));
  const config = readFileSync(join(root, 'examples/features.yaml'), 'utf8');
  writeFileSync(file, config.replace('port: 8080', `port: ${port}`));
  assert.equal(cli('validate', 'validate', file).code, 'OK');
  const plan = cli('plan', 'plan', file).data;
  assert.deepEqual(plan.added, ['places']);
  const publicUrl = `http://localhost:${port}`;
  assert.equal(plan.newUrl, `${publicUrl}/features/collections/places`);

  try {
    assert.equal(cli('apply', 'apply', plan.planId).code, 'OK');
    const testFilter = mode === '--smoke' ? ['--test-name-pattern=^the applied'] : [];
    console.log(run('test-http', 'docker', [
      'run', '--rm', ...containerUser, ...resultsMount, '--network', `${project}_default`,
      '--env', 'GIS_TEST_GATEWAY=http://caddy',
      '--env', `GIS_TEST_PUBLIC_URL=${publicUrl}`,
      image, 'node', '--test', ...testFilter, 'tests/http.test.mjs',
    ]));
  } catch (error) {
    try {
      run('stack-containers', 'docker', ['compose', '-p', project, 'ps', '--all']);
      run('stack-services', 'docker', ['compose', '-p', project, 'logs', '--no-color']);
    } catch (diagnosticsError) {
      console.error(diagnosticsError.message);
    }
    throw error;
  } finally {
    run('stack-down', 'docker', ['compose', '-p', project, 'down', '--volumes']);
  }
}

console.log(`Results: ${results}`);
run('build-test-image', 'docker', ['build', '-f', 'tests/Dockerfile', '-t', image, '.']);
if (mode !== '--smoke') {
  console.log(run('test-cli', 'docker', [
    'run', '--rm', ...containerUser, ...resultsMount,
    image, 'node', '--test', 'tests/config.test.mjs',
  ]));
}
if (mode !== '--cli') await runHttpTests();
