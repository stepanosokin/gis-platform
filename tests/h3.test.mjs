import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { parse, stringify } from 'yaml';

const filename = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const project = process.env.COMPOSE_PROJECT_NAME;
const database = `${project}-external-postgis`;
const postgis = 'postgis/postgis:18-3.6@sha256:4a43e3c3e5d55b9208240fc71db543b79c638766280c625a425bd0a2390989c4';
const bay = '85283083fffffff';
const dateline = '857eb573fffffff';

function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function checked(executable, args, input) {
  const result = command(executable, args, input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function docker(...args) {
  return checked('docker', args);
}

function sql(statement) {
  return checked('docker', ['exec', '-i', database, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], statement);
}

function cli(...args) {
  return JSON.parse(checked(process.execPath, ['dist/cli.js', 'config', ...args, '--json']));
}

async function get(href, expected = 200, options = {}) {
  const url = new URL(href, gateway);
  assert.equal(url.origin, gateway);
  const response = await fetch(url, {
    ...options, signal: AbortSignal.timeout(10_000), headers: { Connection: 'close', ...options.headers },
  });
  assert.equal(response.status, expected, url.href);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
}

function ids({ features }) {
  return features.map(({ id }) => id).sort();
}

test('prepared H3 observations use the standard Features and Martin gateway routes', async (t) => {
  const platform = parse(await readFile('examples/h3-postgis.yaml', 'utf8'));
  const network = `${project}_default`;
  docker('network', 'create', '--label', `com.docker.compose.project=${project}`,
    '--label', 'com.docker.compose.network=default', network);
  let started = false;
  t.after(() => {
    try {
      if (started) docker('rm', '-f', '-v', database);
    } finally {
      docker('compose', '-p', project, '-f', 'compose.yaml', 'down', '--remove-orphans', '--volumes');
    }
  });
  const adminFile = join(dirname(filename), 'h3-admin-password');
  const readerFile = join(dirname(filename), 'h3-reader-password');
  const readerPassword = randomBytes(24).toString('hex');
  await writeFile(adminFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  await writeFile(readerFile, readerPassword, { mode: 0o600 });
  docker('run', '-d', '--name', database, '--network', network, '--network-alias', 'external-postgis',
    '-p', '127.0.0.1::5432',
    '--mount', `type=bind,src=${adminFile},dst=/run/secrets/password,readonly`,
    '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/password', postgis);
  started = true;
  for (let attempt = 0; ; attempt++) {
    const ready = command('docker', ['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
    if (ready.status === 0) break;
    assert.ok(attempt < 40, ready.stdout || ready.stderr);
    await setTimeout(500);
  }
  sql(await readFile('tests/h3-fixture.sql', 'utf8'));
  sql(`
    CREATE ROLE h3_reader LOGIN PASSWORD '${readerPassword}';
    GRANT USAGE ON SCHEMA h3_data TO h3_reader;
    GRANT SELECT ON h3_data.published_observations TO h3_reader;
  `);
  platform.server.port = Number(new URL(gateway).port);
  Object.assign(platform.postgis_connections.h3,
    { host: 'external-postgis', database: 'postgres', password_file: readerFile });
  await writeFile(filename, stringify(platform));
  assert.equal(cli('validate', filename).code, 'OK');
  assert.equal(cli('apply', cli('plan', filename).data.planId).code, 'OK');

  const collection = '/pygeoapi/features/collections/h3-observations';
  const items = `${collection}/items`;
  const data = async (query = '', options) => (await get(`${items}?f=json${query}`, 200, options)).json();
  const item = async (id) => (await get(`${items}/${id}?f=json`)).json();

  await t.test('the DBA view publishes distinct string IDs, cell boundaries and measurements', async () => {
    const grants = sql(`
      SELECT has_schema_privilege('h3_reader', 'h3_data', 'USAGE'),
             has_schema_privilege('h3_reader', 'h3_data', 'CREATE'),
             has_table_privilege('h3_reader', 'h3_data.published_observations', 'SELECT'),
             has_table_privilege('h3_reader', 'h3_data.published_observations', 'INSERT,UPDATE,DELETE'),
             has_table_privilege('h3_reader', 'h3_data.observations', 'SELECT,INSERT,UPDATE,DELETE');
    `);
    assert.equal(grants, 't|f|t|f|f');
    const features = await data();
    assert.deepEqual(ids(features), ['bay-null', 'bay-zero', 'dateline']);
    const zero = await item('bay-zero');
    const unknown = await item('bay-null');
    assert.equal(zero.id, 'bay-zero');
    assert.equal(unknown.id, 'bay-null');
    for (const observation of [zero, unknown]) {
      assert.equal(observation.properties.h3_id, bay);
      assert.equal(observation.properties.resolution, 5);
      assert.equal(observation.geometry.type, 'MultiPolygon');
      assert.equal(observation.geometry.coordinates[0][0].length, 7);
    }
    assert.equal(zero.properties.measurement, 0);
    assert.equal(unknown.properties.measurement, null);
    assert.deepEqual(zero.geometry, unknown.geometry);
    const crossing = await item('dateline');
    assert.equal(crossing.properties.h3_id, dateline);
    assert.equal(crossing.properties.measurement, 27);
    assert.equal(crossing.geometry.type, 'MultiPolygon');
    assert.equal(crossing.geometry.coordinates.length, 2);
    const [west, east] = crossing.geometry.coordinates.map(([ring]) => ring.map(([lon]) => lon));
    assert.equal(Math.min(...west), -180);
    assert.ok(west.every((lon) => lon >= -180 && lon < -179.9));
    assert.equal(Math.max(...east), 180);
    assert.ok(east.every((lon) => lon > 179.9 && lon <= 180));
  });

  await t.test('Features advertises and serves CRS, linked metadata and filters', async () => {
    const crs84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
    const epsg = (code) => `http://www.opengis.net/def/crs/EPSG/0/${code}`;
    const catalog = await (await get('/pygeoapi/features/collections?f=json')).json();
    const metadataLink = catalog.collections.find(({ id }) => id === 'h3-observations').links
      .find(({ rel, type }) => rel === 'self' && type === 'application/json');
    const metadata = await (await get(metadataLink.href)).json();
    assert.deepEqual(metadata.crs, [crs84, epsg(4326), epsg(3857)]);
    const itemsLink = metadata.links.find(({ rel, type }) => rel === 'items' && type.includes('json'));
    assert.deepEqual(ids(await (await get(itemsLink.href)).json()), ['bay-null', 'bay-zero', 'dateline']);
    const queryablesLink = metadata.links.find(({ rel }) => rel.endsWith('/queryables'));
    const queryables = await (await get(queryablesLink.href)).json();
    assert.equal(queryables.properties.h3_id.type, 'string');
    assert.equal(queryables.properties.measurement.type, 'integer');
    const api = await (await get('/pygeoapi/features/openapi?f=json')).json();
    const operation = api.paths['/collections/h3-observations/items'];
    assert.ok(operation.get.parameters.some(({ name }) => name === 'filter-lang'));
    assert.ok(operation.post.requestBody.content['application/json']);

    const zero = await item('bay-zero');
    const [lon, lat] = zero.geometry.coordinates[0][0][0];
    assert.ok(Math.abs(lon - (-122.283803529)) < 1e-8);
    assert.ok(Math.abs(lat - 37.716441562) < 1e-8);
    const geographic = await get(`${items}/bay-zero?f=json&crs=${epsg(4326)}`);
    assert.equal(geographic.headers.get('content-crs'), `<${epsg(4326)}>`);
    assert.deepEqual((await geographic.json()).geometry.coordinates[0][0][0], [lat, lon]);
    const projected = await get(`${items}/bay-zero?f=json&crs=${epsg(3857)}`);
    assert.equal(projected.headers.get('content-crs'), `<${epsg(3857)}>`);
    const [x, y] = (await projected.json()).geometry.coordinates[0][0][0];
    assert.ok(x > -13_613_000 && x < -13_612_000);
    assert.ok(y > 4_539_000 && y < 4_541_000);
    for (const filter of [
      '&bbox=-122.43,37.78,-122.41,37.80',
      `&bbox-crs=${epsg(4326)}&bbox=37.78,-122.43,37.80,-122.41`,
      `&bbox-crs=${epsg(3857)}&bbox=-13632000,4500000,-13590000,4570000`,
    ]) {
      const selected = await data(filter);
      assert.deepEqual(ids(selected), ['bay-null', 'bay-zero']);
      const bboxZero = selected.features.find(({ id }) => id === 'bay-zero');
      assert.equal(bboxZero.properties.measurement, 0);
      assert.deepEqual(bboxZero.geometry, zero.geometry);
    }
    for (const bbox of ['179.96,0.02,179.99,0.04', '-179.99,0.02,-179.97,0.04']) {
      const selected = await data(`&bbox=${bbox}`);
      assert.deepEqual(ids(selected), ['dateline']);
      assert.equal(selected.features[0].geometry.coordinates.length, 2);
      assert.equal(selected.features[0].properties.measurement, 27);
    }
    assert.deepEqual(ids(await data('&bbox=49.9,29.8,50.2,30.1')), []);
    await get(`${items}/852c9bdbfffffff?f=json`, 404);
    assert.deepEqual(ids(await data('&filter-lang=cql2-text&filter=' + encodeURIComponent(`h3_id = '${bay}'`))),
      ['bay-null', 'bay-zero']);
    assert.deepEqual(ids(await data('&filter-lang=cql2-text&filter=' + encodeURIComponent('measurement IS NULL'))),
      ['bay-null']);
    assert.deepEqual(ids(await data('&filter-lang=cql2-json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: '=', args: [{ property: 'measurement' }, 0] }),
    })), ['bay-zero']);
    assert.deepEqual(ids(await data('&datetime=2026-11-02T12:00:00Z/..')), ['bay-null', 'dateline']);
  });

  const layerId = 'h3-observation-tiles';
  const tileJson = await (await get(`/mvt/${layerId}`)).json();
  assert.deepEqual(tileJson.tiles, [`${gateway}/mvt/${layerId}/{z}/{x}/{y}`]);
  const tile = (z, x, y) => tileJson.tiles[0].replace('{z}', z).replace('{x}', x).replace('{y}', y);
  async function tileFeatures(z, x, y) {
    const response = await get(tile(z, x, y));
    assert.match(response.headers.get('content-type'), /^application\/(?:vnd\.mapbox-vector-tile|x-protobuf)/);
    const { layers } = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer())));
    const layer = layers[layerId];
    assert.equal(layer.version, 2);
    return Array.from({ length: layer.length }, (_, index) => layer.feature(index).toGeoJSON(x, y, z));
  }

  await t.test('Martin clips H3 polygons and retains the original measurements and string IDs', async () => {
    assert.deepEqual(Object.keys(tileJson.vector_layers[0].fields).sort(),
      ['feature_id', 'h3_id', 'measurement', 'resolution']);
    const bayTile = await tileFeatures(7, 20, 49);
    assert.deepEqual(bayTile.map(({ properties }) => properties.feature_id).sort(), ['bay-null', 'bay-zero']);
    for (const { geometry, properties } of bayTile) {
      assert.equal(geometry.type, 'Polygon');
      assert.equal(properties.h3_id, bay);
      assert.equal(properties.resolution, 5);
    }
    assert.equal(bayTile.find(({ properties }) => properties.feature_id === 'bay-zero').properties.measurement, 0);
    assert.ok(!Object.hasOwn(bayTile.find(({ properties }) => properties.feature_id === 'bay-null').properties, 'measurement'));
    for (const [zoom, x, y, side] of [[7, 0, 63, -1], [7, 127, 63, 1], [14, 16383, 8191, 1]]) {
      const [feature, ...others] = await tileFeatures(zoom, x, y);
      assert.equal(others.length, 0);
      assert.deepEqual({ ...feature.properties }, { feature_id: 'dateline', h3_id: dateline, resolution: 5, measurement: 27 });
      assert.equal(feature.geometry.type, 'Polygon');
      const [ring] = feature.geometry.coordinates;
      assert.ok(ring.every(([lon]) => lon * side > 179.9 && lon * side <= 180.001));
      if (zoom === 14) {
        assert.ok(ring.every(([, lat]) => lat >= -0.001 && lat <= 0.023));
      }
    }
    await get(tile(7, 64, 63), 204);
    await get(tile(7, 81, 52), 204);
  });

  await t.test('new requests see insert, update and delete after COMMIT at both existing URLs', async () => {
    const bbox = '&bbox=11.8,39.9,12.2,40.2';
    const insertedTile = tile(7, 68, 48);
    assert.deepEqual(ids(await data(bbox)), []);
    await get(insertedTile, 204);
    sql(`BEGIN; INSERT INTO h3_data.observations VALUES
      ('new-observation', '851e9133fffffff', '2026-11-04T12:00Z', 13); COMMIT;`);
    assert.deepEqual(ids(await data(bbox)), ['new-observation']);
    assert.equal((await item('new-observation')).properties.measurement, 13);
    assert.deepEqual((await tileFeatures(7, 68, 48)).map(({ properties }) => properties.measurement), [13]);
    sql("BEGIN; UPDATE h3_data.observations SET measurement = 31 WHERE feature_id = 'new-observation'; COMMIT;");
    assert.equal((await item('new-observation')).properties.measurement, 31);
    assert.deepEqual((await tileFeatures(7, 68, 48)).map(({ properties }) => properties.measurement), [31]);
    sql("BEGIN; DELETE FROM h3_data.observations WHERE feature_id = 'new-observation'; COMMIT;");
    assert.deepEqual(ids(await data(bbox)), []);
    await get(`${items}/new-observation?f=json`, 404);
    await get(insertedTile, 204);
  });
});
