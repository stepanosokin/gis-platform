import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { stringify } from 'yaml';
import { register, signIn } from './access-client.mjs';

const filename = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const project = process.env.COMPOSE_PROJECT_NAME;
const database = `${project}-external-postgis`;
const providerImage = 'geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a';

function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function docker(...args) {
  const result = command('docker', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sql(statement) {
  const result = command('docker', ['exec', '-i', database, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], statement);
  assert.equal(result.status, 0, result.stderr);
}

function cli(...args) {
  const result = cliResult(...args);
  assert.equal(result.status, 0, result.stdout);
  return JSON.parse(result.stdout).data;
}

function cliResult(...args) {
  return command(process.execPath, ['dist/cli.js', 'config', ...args, '--json']);
}

async function request(path, expected = 200, options = {}) {
  const response = await fetch(gateway + path, {
    ...options, headers: { Connection: 'close', ...options.headers }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, `${path}: ${response.status}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  return body ? JSON.parse(body) : undefined;
}

test('dynamic PostGIS publications through the gateway', async (t) => {
  const network = `${project}_default`;
  docker('network', 'create', '--label', `com.docker.compose.project=${project}`,
    '--label', 'com.docker.compose.network=default', network);
  let started = false;
  t.after(() => {
    try {
      if (started) docker('stop', database);
    } finally {
      docker('compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f', 'compose.mailpit.yaml',
        'down', '--remove-orphans', '--volumes');
    }
  });
  const password = randomBytes(24).toString('hex');
  const passwordFile = join(dirname(filename), 'test-postgres-password');
  await writeFile(passwordFile, password, { mode: 0o600 });
  docker('run', '-d', '--rm', '--name', database, '--network', network, '--network-alias', 'external-postgis',
    '--mount', `type=bind,src=${passwordFile},dst=/run/secrets/password,readonly`,
    '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/password', 'postgis/postgis:18-3.6');
  started = true;
  // The image starts a socket-only server to initialize extensions before opening the network socket.
  for (let attempt = 0; ; attempt++) {
    const ready = command('docker', ['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
    if (ready.status === 0) break;
    assert.ok(attempt < 40, ready.stdout || ready.stderr);
    await setTimeout(500);
  }
  const readerPassword = randomBytes(24).toString('hex');
  const alternatePassword = randomBytes(24).toString('hex');
  sql(`
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE ROLE gis_reader LOGIN PASSWORD '${readerPassword}';
    CREATE SCHEMA gis;
    CREATE TABLE gis.observations (id text PRIMARY KEY, label text NOT NULL,
      observed_at timestamptz NOT NULL, geom geometry(Point, 4326) NOT NULL);
    CREATE VIEW gis."Published observations" AS SELECT id, label, observed_at, geom FROM gis.observations;
    CREATE VIEW gis.unlisted AS SELECT id, label, observed_at, geom FROM gis.observations;
    GRANT USAGE ON SCHEMA gis TO gis_reader;
    GRANT SELECT ON gis."Published observations", gis.unlisted TO gis_reader;
    CREATE ROLE gis_alternate LOGIN PASSWORD '${alternatePassword}';
    CREATE DATABASE alternate;
    \\connect alternate
    CREATE EXTENSION postgis;
    CREATE SCHEMA gis;
    CREATE TABLE gis."Published observations" (id text PRIMARY KEY, label text NOT NULL, geom geometry(Point, 4326) NOT NULL);
    INSERT INTO gis."Published observations" VALUES ('alternate', 'Other archive', ST_SetSRID(ST_MakePoint(39, 57), 4326));
    GRANT USAGE ON SCHEMA gis TO gis_alternate;
    GRANT SELECT ON gis."Published observations" TO gis_alternate;
  `);
  const connection = async (dbname, user, password) => {
    const file = join(dirname(filename), `${dbname}.password`);
    await writeFile(file, password + '\n', { mode: 0o600 });
    return { host: 'external-postgis', database: dbname, user, password_file: file };
  };
  const authFiles = {};
  for (const name of ['secret_file', 'postgres_password_file']) {
    const file = join(dirname(filename), name);
    await writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    authFiles[name] = file;
  }
  const observation = { protocol: 'features', provider: 'observations', source: 'external-places', access: 'public',
    title: 'Observations', description: 'Read-only database observations.', extent: [37, 55, 40, 58],
    freshness: { max_delay_seconds: 0 }, time_field: 'observed_at' };
  const source = { type: 'postgis', schema: 'gis', relation: 'Published observations',
    id_field: 'id', geometry_field: 'geom', max_lag_seconds: 0 };
  const geojsonFile = join(dirname(filename), 'places.geojson');
  const geojson = JSON.parse(await readFile('examples/places.geojson', 'utf8'));
  await writeFile(geojsonFile, JSON.stringify(geojson));
  const managed = {
    type: 'pygeoapi', image: providerImage,
    api: { protocol: 'features', scheme: 'http', port: 8081, base_path: '/',
      public_root: '/features', links: 'canonical', readiness: '/openapi?f=json' },
  };
  const draft = {
    schema_version: 1, server: { host: 'localhost', port: Number(new URL(gateway).port) },
    auth: { mode: 'development', mailpit_port: Number(new URL(process.env.GIS_TEST_MAILPIT).port), ...authFiles },
    sources: {
      'external-places': source,
      'unlisted': { ...source, relation: 'unlisted' },
      'file-places': { type: 'geojson', path: geojsonFile },
    },
    providers: {
      observations: { type: 'pygeoapi', postgis: await connection('postgres', 'gis_reader', readerPassword) },
      archive: { ...managed, postgis: await connection('alternate', 'gis_alternate', alternatePassword) },
      files: { ...managed },
    },
    publications: {
      observations: observation,
      registered: { ...observation, access: 'registered' },
      archive: { ...observation, provider: 'archive', title: 'Archive', time_field: undefined, freshness: undefined },
      file: { ...observation, provider: 'files', source: 'file-places', title: 'File', time_field: undefined, freshness: undefined },
    },
  };
  await writeFile(filename, stringify(draft));
  let { planId: confirmed } = cli('plan', filename);
  cli('apply', confirmed);
  const collection = '/features/collections/observations';
  const items = collection + '/items?f=json';
  const ids = ({ features }) => features.map(({ id }) => id);
  const archive = '/features/collections/archive/items?f=json';
  const file = '/features/collections/file/items?f=json';
  await t.test('separate instances use independent connections and expose only explicit sources', async () => {
    const catalog = await request('/features/collections?f=json');
    assert.deepEqual(catalog.collections.map(({ id }) => id).sort(), ['archive', 'file', 'observations']);
    assert.deepEqual(ids(await request(archive)), ['alternate']);
    assert.equal(ids(await request(file)).length, 3);
    await request('/features/collections/unlisted/items?f=json', 404);
  });
  await t.test('read-only view reflects INSERT, UPDATE and DELETE after COMMIT at the same URL', async () => {
    assert.deepEqual((await request(items)).features, []);
    sql(`BEGIN; INSERT INTO gis.observations VALUES
      ('first', 'Initial', '2026-11-01T12:00:00Z', ST_SetSRID(ST_MakePoint(38, 56), 4326)); COMMIT;`);
    const added = (await request(items)).features;
    assert.deepEqual(added.map(({ id, properties }) => [id, properties.label]), [['first', 'Initial']]);
    assert.deepEqual(added[0].geometry.coordinates, [38, 56]);
    sql("BEGIN; UPDATE gis.observations SET label = 'Changed' WHERE id = 'first'; COMMIT;");
    assert.equal((await request(items)).features[0].properties.label, 'Changed');
    assert.equal((await request(collection + '/items/first?f=json')).properties.label, 'Changed');
    sql("BEGIN; DELETE FROM gis.observations WHERE id = 'first'; COMMIT;");
    assert.deepEqual((await request(items)).features, []);
    await request(collection + '/items/first?f=json', 404);
  });

  await t.test('the publication serves and describes CQL2 Text, CQL2 JSON and temporal filters', async () => {
    sql(`INSERT INTO gis.observations VALUES
      ('early', 'Same', '2026-11-01T12:00:00Z', ST_SetSRID(ST_MakePoint(38, 56), 4326)),
      ('middle', 'Other', '2026-11-02T12:00:00Z', ST_SetSRID(ST_MakePoint(38, 56), 4326)),
      ('late', 'Same', '2026-11-03T12:00:00Z', ST_SetSRID(ST_MakePoint(38, 56), 4326));`);
    assert.deepEqual(ids(await request(items + '&filter-lang=cql2-text&filter=' + encodeURIComponent("label = 'Same'"))),
      ['early', 'late']);
    assert.deepEqual(ids(await request(items + '&filter-lang=cql2-json', 200, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: '=', args: [{ property: 'label' }, 'Other'] }),
    })), ['middle']);
    const pageFilter = {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: '=', args: [{ property: 'label' }, 'Same'] }),
    };
    const firstPage = await request(items + '&filter-lang=cql2-json&limit=1', 200, pageFilter);
    assert.deepEqual(ids(firstPage), ['early']);
    const nextPage = new URL(firstPage.links.find(({ rel }) => rel === 'next').href);
    assert.equal(nextPage.origin, gateway);
    assert.deepEqual(ids(await request(nextPage.pathname + nextPage.search, 200, pageFilter)), ['late']);
    for (const [datetime, expected] of [
      ['2026-11-02T12:00:00Z', ['middle']],
      ['2026-11-01T12:00:00Z/2026-11-02T12:00:00Z', ['early', 'middle']],
      ['../2026-11-02T12:00:00Z', ['early', 'middle']],
      ['2026-11-02T12:00:00Z/..', ['late', 'middle']],
    ]) {
      assert.deepEqual(ids(await request(items + '&datetime=' + encodeURIComponent(datetime))), expected);
    }
    await request(items, 404, { method: 'POST', headers: { 'Content-Type': 'application/geo+json' }, body: '{}' });
    assert.equal((await request(items + '&filter-lang=cql2-text&filter=invalid', 400)).code, 'InvalidParameterValue');
    const queryables = await request(collection + '/queryables?f=json');
    assert.equal(queryables.properties.label.type, 'string');
    const api = await request('/features/openapi?f=json');
    const operations = api.paths['/collections/observations/items'];
    assert.ok(operations.get.parameters.some((parameter) => parameter.$ref?.endsWith('/parameters/datetime')));
    assert.ok(operations.get.parameters.some((parameter) => parameter.name === 'filter'));
    assert.ok(operations.get.parameters.some((parameter) =>
      parameter.name === 'filter-lang' && parameter.schema.enum.includes('cql2-text')));
    assert.ok(operations.post.requestBody.content['application/json']);
    assert.ok(!api.paths['/collections/archive/items'].get.parameters.some((parameter) => parameter.$ref?.endsWith('/parameters/datetime')));
    assert.equal(api.paths['/collections/file/items'].post, undefined);
  });
  await t.test('CQL2 JSON follows publication access and the OpenAPI describes the protected operation', async () => {
    const path = '/features/collections/registered/items?f=json';
    const filter = { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ op: '=', args: [{ property: 'label' }, 'Other'] }) };
    await request(path, 401, filter);
    const email = 'postgis-reader@example.test';
    const password = randomBytes(24).toString('hex');
    await register(email, password);
    const cookie = await signIn(email, password);
    assert.deepEqual(ids(await request(path, 200, { ...filter, headers: { ...filter.headers, Cookie: cookie } })), ['middle']);
    const api = await request('/features/openapi?f=json', 200, { headers: { Cookie: cookie } });
    assert.deepEqual(api.paths['/collections/registered/items'].post.security, [{ session: [] }, { bearer: [] }]);
  });
  await t.test('loss of read access is reported as unavailable and other publications can still read', async () => {
    sql('REVOKE SELECT ON gis."Published observations" FROM gis_reader;');
    try {
      assert.equal((await request(items, 503)).code, 'ServiceUnavailable');
      assert.equal((await request(collection + '/items/early?f=json', 503)).code, 'ServiceUnavailable');
      assert.deepEqual(ids(await request(archive)), ['alternate']);
      assert.equal(ids(await request(file)).length, 3);
    } finally {
      sql('GRANT SELECT ON gis."Published observations" TO gis_reader;');
    }
    assert.deepEqual(ids(await request(items)), ['early', 'late', 'middle']);
  });
  await t.test('changing a GeoJSON file served by another instance does not require an unchanged PostGIS source', async () => {
    sql('REVOKE SELECT ON gis."Published observations" FROM gis_reader;');
    try {
      geojson.features[0].properties.name = 'New file value';
      await writeFile(geojsonFile, JSON.stringify(geojson));
      const plan = cli('plan', filename);
      assert.ok(!plan.services.includes('pygeoapi'));
      cli('apply', plan.planId);
      confirmed = plan.planId;
      assert.equal((await request(file)).features[0].properties.name, 'New file value');
      await request(items, 503);
    } finally {
      sql('GRANT SELECT ON gis."Published observations" TO gis_reader;');
    }
  });
  await t.test('a rejected connection leaves the confirmed publications available without exposing credentials', async () => {
    const wrongPassword = randomBytes(24).toString('hex');
    const badFile = join(dirname(filename), 'invalid-connection.password');
    await writeFile(badFile, wrongPassword, { mode: 0o600 });
    draft.providers.observations.postgis.password_file = badFile;
    await writeFile(filename, stringify(draft));
    const plan = cli('plan', filename);
    assert.ok(plan.changed.includes('observations'));
    assert.ok(plan.services.includes('pygeoapi'));
    const result = cliResult('apply', plan.planId);
    assert.equal(result.status, 6);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.code, 'APPLY_FAILED');
    assert.equal(reply.data.currentVersion, confirmed);
    assert.equal((result.stdout + result.stderr).includes(wrongPassword), false);
    assert.deepEqual(ids(await request(items)), ['early', 'late', 'middle']);
  });
  await t.test('active and retired PostGIS IDs stay bound to the original database and relation', async () => {
    draft.providers.observations.postgis.password_file = join(dirname(filename), 'postgres.password');
    const reassigned = { ...draft.publications.archive, title: 'Reassigned' };
    draft.publications.observations = reassigned;
    await writeFile(filename, stringify(draft));
    const active = cliResult('plan', filename);
    assert.equal(active.status, 2);
    assert.match(JSON.parse(active.stdout).data.message, /reserved for its original source/);
    delete draft.publications.observations;
    await writeFile(filename, stringify(draft));
    cli('apply', cli('plan', filename).planId);
    draft.publications.observations = reassigned;
    await writeFile(filename, stringify(draft));
    const result = cliResult('plan', filename);
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).data.message, /reserved for its original source/);
    const replacementFile = join(dirname(filename), 'replacement.password');
    await writeFile(replacementFile, readerPassword, { mode: 0o600 });
    draft.providers.observations.postgis.password_file = replacementFile;
    draft.publications.observations = observation;
    await writeFile(filename, stringify(draft));
    assert.deepEqual(cli('plan', filename).added, ['observations']);
  });
});
