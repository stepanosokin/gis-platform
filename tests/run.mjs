import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resultsRoot = join(root, 'test_results');
mkdirSync(resultsRoot, { recursive: true });
const mode = process.argv[2];
const results = mkdtempSync(join(resultsRoot, 'gis-test-'));
const project = `gis-platform-${basename(results).toLowerCase()}`;
const image = 'gis-platform-issue-14-tests';
const toolsImage = 'geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a';
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

async function qgisPluginIsListening() {
  const port = Number(process.env.QGIS_MCP_PORT ?? 9876);
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
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
    if (mode !== '--versions' && mode !== '--providers') {
      const testFilter = mode === '--smoke' ? ['--test-name-pattern=^the applied'] : [];
      console.log(run('test-http', 'docker', [
        'run', '--rm', ...containerUser, ...resultsMount, '--network', `${project}_default`,
        '--env', 'GIS_TEST_GATEWAY=http://caddy',
        '--env', `GIS_TEST_PUBLIC_URL=${publicUrl}`,
        image, 'node', '--test', ...testFilter, 'tests/http.test.mjs',
      ]));
    }
    if (mode === '--versions' || !mode) {
      writeFileSync(file, config.replace('port: 8080', `port: ${port}`));
      makeGatewayCertificate('versions');
      const filter = mode === '--versions' && process.argv[3] ? [`--test-name-pattern=${process.argv[3]}`] : [];
      console.log(run('test-versions', process.execPath, ['--test', ...filter, 'tests/versions.test.mjs'], {
        ...stackEnvironment, GIS_TEST_PUBLIC_URL: publicUrl, GIS_TEST_CONFIG: file,
      }));
    }
    if (mode === '--providers' || !mode) {
      const filter = mode === '--providers' && process.argv[3] ? [`--test-name-pattern=${process.argv[3]}`] : [];
      console.log(run('test-providers', process.execPath, ['--test', ...filter, 'tests/providers.test.mjs'], {
        ...stackEnvironment, GIS_TEST_PUBLIC_URL: publicUrl, GIS_TEST_CONFIG: file,
      }));
    }
  } catch (error) {
    try {
      run('stack-containers', 'docker', ['compose', '-p', project, 'ps', '--all']);
      run('stack-services', 'docker', ['compose', '-p', project, 'logs', '--no-color']);
    } catch (diagnosticsError) {
      console.error(diagnosticsError.message);
    }
    throw error;
  } finally {
    run('stack-down', 'docker', ['compose', '-p', project, 'down', '--remove-orphans', '--volumes']);
    removeTestVolumes(project);
  }
}

async function runPostgisTests() {
  run('build-postgis-cli', process.execPath, ['node_modules/typescript/bin/tsc']);
  const port = await freePort();
  const mailPort = await freePort();
  console.log(run('test-postgis', process.execPath, ['--test', 'tests/postgis.test.mjs'], {
    COMPOSE_PROJECT_NAME: `${project}-postgis`, GIS_STATE_DIR: join(results, 'postgis-state'),
    GIS_TEST_PUBLIC_URL: `http://localhost:${port}`, GIS_TEST_MAILPIT: `http://localhost:${mailPort}`,
    GIS_TEST_CONFIG: join(results, 'postgis.yaml'),
  }));
}

async function runFeaturesFilesTests() {
  run('build-files-cli', process.execPath, ['node_modules/typescript/bin/tsc']);
  const parquetImage = 'gis-platform-pygeoapi-parquet:0.24.0-arrow-23.0.1';
  run('build-parquet-image', 'docker', ['build', '-f', 'Dockerfile.pygeoapi', '-t', parquetImage, '.']);
  run('create-feature-files', 'docker', ['run', '--rm', ...containerUser, ...resultsMount,
    '--mount', `type=bind,src=${join(root, 'tests/features-files-fixtures.py')},dst=/fixtures.py,readonly`,
    '--entrypoint', '/venv/bin/python', parquetImage, '/fixtures.py']);
  const port = await freePort();
  const name = `${project}-files`;
  const filter = mode === '--features-files' && process.argv[3] ? [`--test-name-pattern=${process.argv[3]}`] : [];
  try {
    console.log(run('test-features-files', process.execPath, ['--test', ...filter, 'tests/features-files.test.mjs'], {
      COMPOSE_PROJECT_NAME: name, GIS_STATE_DIR: join(results, 'files-state'),
      GIS_TEST_PUBLIC_URL: `http://localhost:${port}`, GIS_TEST_CONFIG: join(results, 'files.yaml'),
    }));
  } finally {
    run('features-files-down', 'docker', ['compose', '-p', name, 'down', '--remove-orphans', '--volumes']);
    removeTestVolumes(name);
  }
}

async function runMapsTests() {
  run('build-maps-cli', process.execPath, ['node_modules/typescript/bin/tsc']);
  run('create-map-files', 'docker', ['run', '--rm', ...containerUser, ...resultsMount,
    '--mount', `type=bind,src=${join(root, 'tests/maps-fixtures.py')},dst=/fixtures.py,readonly`,
    '--entrypoint', '/venv/bin/python', toolsImage, '/fixtures.py']);
  const name = `${project}-maps`;
  const filter = mode === '--maps' && process.argv[3] ? [`--test-name-pattern=${process.argv[3]}`] : [];
  const adminPort = String(await freePort());
  makeAdminCertificates();
  const environment = {
    COMPOSE_PROJECT_NAME: name,
    GIS_STATE_DIR: join(results, 'maps-state'),
    GIS_TEST_PUBLIC_URL: `http://localhost:${await freePort()}`,
    GIS_TEST_MAILPIT: `http://localhost:${await freePort()}`,
    GIS_TEST_CONFIG: join(results, 'maps.yaml'),
    GIS_ADMIN_PORT: adminPort,
    GIS_ADMIN_CA_FILE: join(results, 'ca.pem'),
    GIS_ADMIN_CERT_FILE: join(results, 'operator.pem'),
    GIS_ADMIN_KEY_FILE: join(results, 'operator-key.pem'),
  };
  try {
    console.log(run('test-maps', process.execPath, ['--test', ...filter, 'tests/maps.test.mjs'], environment));
  } finally {
    run('maps-down', 'docker', ['compose', '-p', name, 'down', '--remove-orphans', '--volumes']);
    removeTestVolumes(name);
  }
}

async function runMartinTests(suite) {
  run(`build-${suite}-cli`, process.execPath, ['node_modules/typescript/bin/tsc']);
  const name = `${project}-${suite}`;
  const filter = mode === `--${suite}` && process.argv[3] ? [`--test-name-pattern=${process.argv[3]}`] : [];
  const withAdmin = suite === 'tiles' || suite === 'mvt';
  const admin = withAdmin ? {
    GIS_ADMIN_PORT: String(await freePort()),
    GIS_ADMIN_CA_FILE: join(results, 'ca.pem'),
    GIS_ADMIN_CERT_FILE: join(results, 'operator.pem'),
    GIS_ADMIN_KEY_FILE: join(results, 'operator-key.pem'),
  } : {};
  if (withAdmin) makeAdminCertificates();
  try {
    console.log(run(`test-${suite}`, process.execPath, ['--test', ...filter, `tests/${suite}.test.mjs`], {
      COMPOSE_PROJECT_NAME: name, GIS_STATE_DIR: join(results, `${suite}-state`),
      GIS_TEST_PUBLIC_URL: `http://localhost:${await freePort()}`, GIS_TEST_CONFIG: join(results, `${suite}.yaml`),
      GIS_TEST_MAILPIT: `http://localhost:${await freePort()}`,
      ...admin,
    }));
  } finally {
    removeTestVolumes(name);
  }
}

function removeTestVolumes(projectName) {
  const output = run(`${projectName}-volumes`, 'docker', ['volume', 'ls', '-q',
    '--filter', `label=com.docker.compose.project=${projectName}`]);
  const volumes = output.trim().split(/\s+/).filter(Boolean);
  if (volumes.length) run(`${projectName}-volume-down`, 'docker', ['volume', 'rm', ...volumes]);
}

function makeAdminCertificates() {
  run('private-certificates', 'docker', ['run', '--rm', ...containerUser, ...resultsMount, '-w', '/results',
    '--entrypoint', '/bin/sh', toolsImage, '-ec', `
    umask 077
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
      -subj /CN=GIS-Test-CA -keyout ca-key.pem -out ca.pem -addext basicConstraints=critical,CA:TRUE
    issue() {
      openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
        -subj "/CN=$1" -keyout "$1-key.pem" -out "$1.csr" -addext "$2"
      openssl x509 -req -days 1 -in "$1.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
        -copy_extensions copy -out "$1.pem"
    }
    issue server subjectAltName=IP:127.0.0.1
    for account in operator agent reader writer outsider; do
      issue "$account" extendedKeyUsage=clientAuth
    done
  `]);
}

function makeGatewayCertificate(suite) {
  run(`certificate-${suite}`, 'docker', ['run', '--rm', ...containerUser, ...resultsMount, '--entrypoint', 'openssl',
    toolsImage,
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext',
    'subjectAltName=DNS:localhost', '-keyout', '/results/https-key.pem', '-out', '/results/https-cert.pem']);
}

async function runAccessTests(suite = 'access', { qgis = false, desktopOnly = false } = {}) {
  run(`build-${suite}-cli`, process.execPath, ['node_modules/typescript/bin/tsc']);
  const accessProject = `${project}-${suite}`;
  const accessEnvironment = { COMPOSE_PROJECT_NAME: accessProject, GIS_STATE_DIR: join(results, `${suite}-state`) };
  const port = await freePort();
  const mailPort = await freePort();
  const file = join(results, `${suite}.yaml`);
  copyFileSync(join(root, 'examples/places.geojson'), join(results, 'places.geojson'));
  for (const name of ['auth-secret', 'postgres-password']) {
    writeFileSync(join(results, name), randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  makeGatewayCertificate(suite);
  const config = readFileSync(join(root, 'examples/features.yaml'), 'utf8');
  const entryStart = config.indexOf('  places:');
  const publicPublication = config.slice(entryStart);
  const registered = publicPublication.replace('  places:', '  registered-places:')
    .replace('access: public', 'access: registered').replace('title: Example places', 'title: Registered example');
  const platform = config.slice(0, entryStart).replace('port: 8080', `port: ${port}`);
  const closed = suite === 'private' ? ['private-places', 'other-private'].map((id) => publicPublication
    .replace('  places:', `  ${id}:`).replace('access: public', 'access: private')
    .replace('title: Example places', `title: ${id === 'private-places' ? 'Closed places' : 'Other closed places'}`)).join('') : '';
  writeFileSync(file, `${platform}${registered}${publicPublication}${closed}\nauth:\n  mode: development\n  secret_file: auth-secret\n  postgres_password_file: postgres-password\n  mailpit_port: ${mailPort}\n`);
  const adminPort = closed ? await freePort() : undefined;
  if (adminPort) {
    makeAdminCertificates();
    writeFileSync(file, `  administrator_emails: [administrator@example.test]
  cli:
    port: ${adminPort}
    ca_file: ca.pem
    cert_file: server.pem
    key_file: server-key.pem
    operators:
      operator: [diagnostics, users-read, access-write]
      agent: [diagnostics]
      reader: [users-read]
      writer: [access-write]
`, { flag: 'a' });
  }
  const plan = cli(`plan-${suite}`, ['plan', file], accessEnvironment).data;
  assert.deepEqual(plan.added, ['registered-places', 'places', ...(closed ? ['private-places', 'other-private'] : [])]);
  try {
    assert.equal(cli(`apply-${suite}`, ['apply', plan.planId], accessEnvironment).code, 'OK');
    const filter = process.argv[3] ? [`--test-name-pattern=${process.argv[3]}`] : [];
    const environment = {
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
      ...(adminPort && {
        GIS_ADMIN_PORT: String(adminPort),
        GIS_ADMIN_CA_FILE: join(results, 'ca.pem'),
        GIS_ADMIN_CERT_FILE: join(results, 'operator.pem'),
        GIS_ADMIN_KEY_FILE: join(results, 'operator-key.pem'),
        GIS_TEST_CLI_IMAGE: image,
        GIS_TEST_RESULTS: results,
      }),
    };
    if (qgis) console.log(run('test-qgis', process.execPath, ['--test', 'tests/qgis.test.mjs'], environment));
    if (!desktopOnly) {
      console.log(run(`test-${suite}`, process.execPath, ['--test', ...filter, `tests/${suite}.test.mjs`], environment));
    }
  } finally {
    run(`${suite}-down`, 'docker', ['compose', '-p', accessProject, '-f', 'compose.yaml', '-f', 'compose.auth.yaml',
      '-f', 'compose.mailpit.yaml', 'down', '--remove-orphans', '--volumes']);
    removeTestVolumes(accessProject);
  }
}

const providerSuites = new Map([
  ['--postgis', runPostgisTests],
  ['--features-files', runFeaturesFilesTests],
  ['--maps', runMapsTests],
  ['--mvt', () => runMartinTests('mvt')],
  ['--raster-tiles', () => runMartinTests('raster-tiles')],
  ['--tiles', () => runMartinTests('tiles')],
]);

console.log(`Results: ${results}`);
const selectedProviderSuite = providerSuites.get(mode);
if (selectedProviderSuite) {
  await selectedProviderSuite();
  process.exit(0);
}
if (mode === '--access') {
  await runAccessTests(mode.slice(2));
  process.exit(0);
}
if (mode === '--qgis') {
  await runAccessTests('private', { qgis: true, desktopOnly: true });
  process.exit(0);
}
run('build-test-image', 'docker', ['build', '-f', 'tests/Dockerfile', '-t', image, '.']);
if (mode === '--versions' || mode === '--providers') {
  await runHttpTests();
  process.exit(0);
}
if (mode === '--private') {
  await runAccessTests('private');
  process.exit(0);
}
if (mode !== '--smoke') {
  console.log(run('test-cli', 'docker', [
    'run', '--rm', ...containerUser, ...resultsMount,
    image, 'node', '--test', 'tests/config.test.mjs',
  ]));
}
if (mode !== '--cli') await runHttpTests();
if (!mode) {
  for (const runSuite of providerSuites.values()) await runSuite();
  await runAccessTests();
  const qgis = process.env.GIS_QGIS_MCP !== '0' &&
    (process.env.GIS_QGIS_MCP === '1' || await qgisPluginIsListening());
  if (!qgis) console.log('QGIS desktop check skipped. Run npm test -- --qgis to require it.');
  await runAccessTests('private', { qgis });
}
