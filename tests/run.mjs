import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resultsRoot = join(root, 'test_results');
mkdirSync(resultsRoot, { recursive: true });
const mode = process.argv[2];
const results = mkdtempSync(join(resultsRoot, mode === '--access' ? 'issue-15-' : 'issue-14-'));
const project = `gis-platform-${basename(results).toLowerCase()}`;
const image = 'gis-platform-issue-14-tests';
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

function cli(name, args, environment = stackEnvironment) {
  const output = run(name, process.execPath, ['dist/cli.js', 'config', ...args, '--json'], environment);
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
  assert.equal(cli('validate', ['validate', file]).code, 'OK');
  const plan = cli('plan', ['plan', file]).data;
  assert.deepEqual(plan.added, ['places']);
  const publicUrl = `http://localhost:${port}`;
  assert.equal(plan.newUrl, `${publicUrl}/features/collections/places`);

  try {
    assert.equal(cli('apply', ['apply', plan.planId]).code, 'OK');
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

async function runAccessTests() {
  run('build-access-cli', process.execPath, ['node_modules/typescript/bin/tsc']);
  const accessProject = mode === '--access' ? project : `${project}-access`;
  const accessEnvironment = { COMPOSE_PROJECT_NAME: accessProject, GIS_STATE_DIR: join(results, 'access-state') };
  const port = await freePort();
  const mailPort = await freePort();
  const file = join(results, 'registration.yaml');
  copyFileSync(join(root, 'examples/places.geojson'), join(results, 'places.geojson'));
  for (const name of ['auth-secret', 'postgres-password']) {
    writeFileSync(join(results, name), randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  run('test-certificate', 'docker', ['run', '--rm', ...containerUser, ...resultsMount, '--entrypoint', 'openssl',
    'geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a',
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext',
    'subjectAltName=DNS:localhost', '-keyout', '/results/https-key.pem', '-out', '/results/https-cert.pem']);
  const config = readFileSync(join(root, 'examples/features.yaml'), 'utf8');
  const entryStart = config.indexOf('  places:');
  const publicPublication = config.slice(entryStart);
  const registered = publicPublication.replace('  places:', '  registered-places:')
    .replace('access: public', 'access: registered').replace('title: Example places', 'title: Registered example');
  const platform = config.slice(0, entryStart).replace('port: 8080', `port: ${port}`);
  writeFileSync(file, `${platform}${registered}${publicPublication}\nauth:\n  mode: development\n  secret_file: auth-secret\n  postgres_password_file: postgres-password\n  mailpit_port: ${mailPort}\n`);
  const plan = cli('plan-access', ['plan', file], accessEnvironment).data;
  assert.deepEqual(plan.added, ['registered-places', 'places']);
  try {
    assert.equal(cli('apply-access', ['apply', plan.planId], accessEnvironment).code, 'OK');
    const filter = process.argv[3] ? [`--test-name-pattern=${process.argv[3]}`] : [];
    console.log(run('test-access', process.execPath, ['--test', ...filter, 'tests/access.test.mjs'], {
      ...accessEnvironment,
      GIS_TEST_PUBLIC_URL: `http://localhost:${port}`,
      GIS_TEST_MAILPIT: `http://localhost:${mailPort}`,
      GIS_TEST_CONFIG: file,
      NODE_EXTRA_CA_CERTS: join(results, 'https-cert.pem'),
      GIS_REVISION_DIR: join(accessEnvironment.GIS_STATE_DIR, 'plans', plan.planId),
      GIS_AUTH_SECRET_FILE: join(results, 'auth-secret'),
      GIS_POSTGRES_PASSWORD_FILE: join(results, 'postgres-password'),
      GIS_PUBLIC_PORT: String(port),
      GIS_MAILPIT_PORT: String(mailPort),
    }));
  } finally {
    run('access-down', 'docker', ['compose', '-p', accessProject, '-f', 'compose.yaml', '-f', 'compose.auth.yaml',
      '-f', 'compose.mailpit.yaml', 'down', '--remove-orphans', '--volumes']);
  }
}

console.log(`Results: ${results}`);
if (mode === '--access') {
  await runAccessTests();
  process.exit(0);
}
run('build-test-image', 'docker', ['build', '-f', 'tests/Dockerfile', '-t', image, '.']);
if (mode !== '--smoke') {
  console.log(run('test-cli', 'docker', [
    'run', '--rm', ...containerUser, ...resultsMount,
    image, 'node', '--test', 'tests/config.test.mjs',
  ]));
}
if (mode !== '--cli') await runHttpTests();
if (!mode) await runAccessTests();
