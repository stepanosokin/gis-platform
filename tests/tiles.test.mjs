import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { stringify } from 'yaml';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { auth, register, signIn } from './access-client.mjs';
import { mapLibreBrowserOptions } from './maplibre-browser.mjs';
import { renderVectorTiles } from './mvt-browser.mjs';

const filename = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const project = process.env.COMPOSE_PROJECT_NAME;
const database = `${project}-external-postgis`;
const collection = '/tiles/collections/observations';
const matrixSet = 'WebMercatorQuad';
const tileset = `${collection}/tiles/${matrixSet}`;
const vectorMediaType = 'application/vnd.mapbox-vector-tile';
const relation = 'http://www.opengis.net/def/rel/ogc/1.0/';
const gatewayUrl = new URL(gateway);

function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function docker(...args) {
  return command('docker', args);
}

function cli(...args) {
  return JSON.parse(command(process.execPath, ['dist/cli.js', ...args, '--json'])).data;
}

async function request(path, expected = 200, headers = {}, method = 'GET') {
  const url = new URL(path, gateway);
  assert.equal(url.origin, gatewayUrl.origin);
  const response = await fetch(url, { method, headers: { Connection: 'close', ...headers }, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, expected, `${url}: ${response.status === expected ? '' : await response.text()}`);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
  return response;
}

const api = {
  scheme: 'http', links: 'canonical',
};
const publication = {
  source: 'observations', provider: 'tiles', tile_provider: 'martin', protocol: 'tiles', access: 'public',
  title: 'Observations', description: 'Known PostGIS points', extent: [-180, -85, 180, 85],
};
const config = {
  schema_version: 1,
  server: { host: 'localhost', port: Number(gatewayUrl.port) },
  sources: { observations: { type: 'postgis', schema: 'gis', relation: 'observations', id_field: 'id',
    geometry_field: 'geom', max_lag_seconds: 0 } },
  providers: {
    tiles: { type: 'pygeoapi', image: 'geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a',
      api: { ...api, protocol: 'tiles', port: 80, base_path: '/', public_root: '/tiles', readiness: '/openapi' } },
    martin: { type: 'martin', image: 'ghcr.io/maplibre/martin:1.16.1@sha256:59902019bf9038926ff0c71174237d6852e64c457830a6349abe7090be8818ca',
      api: { ...api, protocol: 'mvt', port: 3000, base_path: '/native', public_root: '/mvt', readiness: '/health' },
      postgis: { host: 'external-postgis', database: 'postgres', user: 'gis_reader', password_file: 'tiles-reader-password' } },
  },
  publications: { observations: publication },
};

async function prepareDatabase(t) {
  const network = `${project}_default`;
  docker('network', 'create', '--label', `com.docker.compose.project=${project}`,
    '--label', 'com.docker.compose.network=default', network);
  let started = false;
  const stop = () => {
    if (started) {
      docker('stop', database);
      started = false;
    }
  };
  t.after(() => {
    try {
      stop();
    } finally {
      docker('compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f', 'compose.mailpit.yaml',
        'down', '--remove-orphans', '--volumes');
    }
  });
  const adminFile = join(dirname(filename), 'tiles-db-password');
  const readerPassword = randomBytes(24).toString('hex');
  await writeFile(adminFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  await writeFile(join(dirname(filename), 'tiles-reader-password'), readerPassword, { mode: 0o600 });
  docker('run', '-d', '--rm', '--name', database, '--network', network, '--network-alias', 'external-postgis',
    '--mount', `type=bind,src=${adminFile},dst=/run/secrets/password,readonly`,
    '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/password',
    'postgis/postgis:18-3.6@sha256:4a43e3c3e5d55b9208240fc71db543b79c638766280c625a425bd0a2390989c4');
  started = true;
  for (let attempt = 0; ; attempt++) {
    const ready = spawnSync('docker', ['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { encoding: 'utf8', windowsHide: true });
    if (ready.status === 0) break;
    assert.ok(attempt < 40, ready.stdout || ready.stderr);
    await setTimeout(500);
  }
  command('docker', ['exec', '-i', database, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], `
    CREATE ROLE gis_reader LOGIN PASSWORD '${readerPassword}';
    CREATE SCHEMA gis;
    CREATE TABLE gis.observations (id text PRIMARY KEY, geom geometry(Point, 4326) NOT NULL);
    GRANT USAGE ON SCHEMA gis TO gis_reader;
    GRANT SELECT ON gis.observations TO gis_reader;
    INSERT INTO gis.observations VALUES ('row-1', ST_SetSRID(ST_MakePoint(1, 1), 4326));
  `);
  return stop;
}

async function apply(platform) {
  await writeFile(filename, stringify(platform));
  const plan = cli('config', 'plan', filename);
  cli('config', 'apply', plan.planId);
  return plan;
}

test('OGC Tiles describes a WebMercatorQuad tileset and links to the vector tile from Martin', async (t) => {
  const stopDatabase = await prepareDatabase(t);
  const plan = await apply(config);
  assert.equal(plan.newUrl, gateway + collection);
  for (const service of ['provider-tiles', 'provider-martin']) assert.ok(plan.services.includes(service));
  const conformance = await (await request('/tiles/conformance?f=json')).json();
  for (const name of ['core', 'mvt', 'tileset', 'tilesets-list', 'geodata-tilesets', 'oas30']) {
    assert.ok(conformance.conformsTo.includes(`http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/${name}`));
  }
  const catalog = await (await request('/tiles/collections?f=json')).json();
  assert.deepEqual(catalog.collections.map(({ id }) => id), ['observations']);
  assert.ok(catalog.collections[0].links.some(({ rel, href }) =>
    rel === relation + 'tilesets-vector' && href === gateway + collection + '/tiles?f=json'));
  const metadata = await (await request(collection + '?f=json')).json();
  const listLink = metadata.links.find(({ rel }) => rel === relation + 'tilesets-vector');
  assert.ok(listLink);
  const { tilesets, links } = await (await request(listLink.href)).json();
  assert.deepEqual(links.filter(({ rel }) => rel === 'self').map(({ href }) => href), [listLink.href]);
  assert.equal(tilesets.length, 1);
  assert.equal(tilesets[0].dataType, 'vector');
  assert.equal(tilesets[0].tileMatrixSetURI, `http://www.opengis.net/def/tilematrixset/OGC/1.0/${matrixSet}`);
  const self = tilesets[0].links.find(({ rel }) => rel === 'self');
  assert.equal(new URL(self.href).pathname, tileset);
  const description = await (await request(self.href)).json();
  assert.deepEqual(await (await request(tileset)).json(), description);
  assert.deepEqual(await (await request(tileset, 200, { Accept: 'application/json' })).json(), description);
  assert.equal(description.dataType, 'vector');
  assert.equal(description.crs, 'http://www.opengis.net/def/crs/EPSG/0/3857');
  const definition = description.links.find(({ rel }) => rel === relation + 'tiling-scheme');
  assert.equal((await (await request(definition.href)).json()).id, matrixSet);
  const tileLink = description.links.find(({ rel, type }) => rel === 'item' && type === vectorMediaType);
  assert.equal(tileLink.templated, true);
  assert.ok(tileLink.href.startsWith(gateway + tileset + '/'));
  const tileUrl = tileLink.href.replace('{tileMatrix}', '2').replace('{tileRow}', '1').replace('{tileCol}', '2');
  const response = await request(tileUrl, 200, { Accept: vectorMediaType });
  assert.equal(response.headers.get('content-type'), vectorMediaType);
  const tile = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer())));
  const defaultTile = await request(tileUrl.split('?')[0]);
  assert.equal(defaultTile.headers.get('content-type'), vectorMediaType);
  await defaultTile.arrayBuffer();
  assert.equal(tile.layers.observations.version, 2);
  const feature = tile.layers.observations.feature(0);
  assert.equal(feature.properties.id, 'row-1');
  const [lon, lat] = feature.toGeoJSON(2, 1, 2).geometry.coordinates;
  assert.ok(Math.abs(lon - 1) < 0.05 && Math.abs(lat - 1) < 0.05);
  const tileJsonLink = description.links.find(({ rel, title }) => rel === 'alternate' && title === 'TileJSON');
  const tileJson = await (await request(tileJsonLink.href)).json();
  assert.equal(tileJson.tilejson, '3.0.0');
  assert.equal(tileJson.scheme, 'xyz');
  assert.deepEqual(tileJson.tiles, [gateway + tileset + '/{z}/{y}/{x}?f=mvt']);
  assert.deepEqual(tileJson.vector_layers, [{ id: 'observations', fields: { id: '' } }]);
  await request(tileset + '/2/0/0?f=mvt', 204);
  await request(tileset + '/2/4/2?f=mvt', 404);
  await request(tileset + '/25/1/2?f=mvt', 404);
  await request(collection + '/tiles/WorldCRS84Quad?f=json', 404);
  const openapi = await (await request('/tiles/openapi?f=json')).json();
  assert.match(openapi.openapi, /^3\.0\./);
  assert.equal(openapi.servers[0].url, gateway + '/tiles');
  const path = '/collections/observations/tiles';
  for (const [suffix, operation] of [['', 'getTileSetsList'], ['/{tileMatrixSetId}', 'getTileSet'],
    ['/{tileMatrixSetId}/{tileMatrix}/{tileRow}/{tileCol}', 'getTile']]) {
    assert.ok(openapi.paths[path + suffix]?.get.operationId.endsWith(`.collection.vector.${operation}`), path + suffix);
  }
  assert.ok(openapi.paths['/TileMatrixSets/{tileMatrixSetId}']?.get);
  const landing = await (await request('/tiles?f=json', 200, {
    Forwarded: 'host=example.invalid;proto=https', 'X-Forwarded-Host': 'example.invalid',
  })).json();
  const registry = landing.links.find(({ rel, type }) => rel === relation + 'tiling-schemes' && type === 'application/json');
  const matrices = await (await request(registry.href)).json();
  assert.ok(matrices.tileMatrixSets.some(({ id }) => id === matrixSet));
  await request(matrices.links.find(({ rel }) => rel === 'self').href);
  await request('/mvt/observations', 404);
  await request('/mvt/observations/2/2/1', 404);
  stopDatabase();
  await request(tileUrl, 503);
  await request(tileJsonLink.href);
  await request('/tiles/openapi?f=json');
});

test('Tiles catalogs, OpenAPI, descriptions and data follow current access grants', async (t) => {
  await prepareDatabase(t);
  for (const name of ['auth-secret', 'postgres-password']) {
    await writeFile(join(dirname(filename), name), randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const privateId = 'private-observations';
  const registeredId = 'registered-observations';
  const browser = createServer();
  await new Promise((resolve, reject) => {
    browser.once('error', reject);
    browser.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${browser.address().port}`;
  await new Promise((resolve) => browser.close(resolve));
  await apply({ ...config, cors: { allowed_origins: [origin] }, auth: {
    mode: 'development', mailpit_port: Number(new URL(process.env.GIS_TEST_MAILPIT).port),
    secret_file: 'auth-secret', postgres_password_file: 'postgres-password',
    cli: { port: Number(process.env.GIS_ADMIN_PORT), ca_file: 'ca.pem', cert_file: 'server.pem',
      key_file: 'server-key.pem', operators: { operator: ['access-write'] } },
  }, publications: {
    ...config.publications,
    [privateId]: { ...publication, access: 'private' },
    [registeredId]: { ...publication, access: 'registered' },
  } });
  const suffixes = ['?f=json', '/tiles?f=json', `/tiles/${matrixSet}?f=json`,
    `/tiles/${matrixSet}?f=tilejson`, `/tiles/${matrixSet}/2/1/2?f=mvt`];
  const pathsFor = (id) => suffixes.map((suffix) => `/tiles/collections/${id}${suffix}`);
  const expectAccess = async (id, status, headers) => {
    for (const path of pathsFor(id)) {
      const response = await request(path, status, headers);
      await response.arrayBuffer();
    }
  };
  const expectVisible = async (ids, headers) => {
    const { collections } = await (await request('/tiles/collections?f=json', 200, headers)).json();
    assert.deepEqual(collections.map(({ id }) => id).sort(), [...ids].sort());
    const { paths } = await (await request('/tiles/openapi?f=json', 200, headers)).json();
    const documented = [...new Set(Object.keys(paths).flatMap((path) => {
      const match = /^\/collections\/([^/]+)/.exec(path);
      return match ? [match[1]] : [];
    }))].sort();
    assert.deepEqual(documented, [...ids].sort());
    for (const id of ids.filter((name) => name !== 'observations')) {
      const path = `/collections/${id}/tiles`;
      for (const suffix of ['', '/{tileMatrixSetId}', '/{tileMatrixSetId}/{tileMatrix}/{tileRow}/{tileCol}']) {
        assert.deepEqual(paths[path + suffix]?.get?.security, [{ session: [] }, { bearer: [] }]);
      }
    }
  };
  await expectVisible(['observations']);
  await expectAccess(privateId, 401);
  await expectAccess(registeredId, 401);
  for (const path of ['/tiles/openapi?f=json', ...pathsFor(privateId).slice(1)]) {
    const preflight = await request(path, 204, {
      Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    }, 'OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
    assert.equal(await preflight.text(), '');
  }
  const denied = await request(pathsFor(privateId).at(-1), 401, { Origin: 'https://other.example.test' });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);

  const email = 'tiles-reader@example.test';
  const password = randomBytes(24).toString('hex');
  await register(email, password);
  const cookie = await signIn(email, password);
  await expectVisible(['observations', registeredId], { Cookie: cookie });
  await expectAccess(registeredId, 200, { Cookie: cookie });
  await expectAccess(privateId, 403, { Cookie: cookie });

  cli('access', 'grant', privateId, '--email', email);
  const token = await auth('tokens/create', { name: 'OGC Tiles' }, cookie);
  assert.equal(token.status, 201);
  const { secret } = await token.json();
  const bearer = { Authorization: `Bearer ${secret}` };
  await expectVisible(['observations', registeredId, privateId], bearer);
  await expectAccess(privateId, 200, bearer);
  const crossOrigin = await request(pathsFor(privateId).at(-1), 200, { ...bearer, Origin: origin });
  assert.equal(crossOrigin.headers.get('access-control-allow-origin'), origin);
  await crossOrigin.arrayBuffer();
  await request(`/mvt/${privateId}/2/2/1`, 404, bearer);
  await t.test('MapLibre GL JS renders OGC tiles through TileJSON with Bearer access', mapLibreBrowserOptions, async () => {
    const [frame] = await renderVectorTiles({ origin, source: gateway + pathsFor(privateId).at(-2),
      layer: privateId, secret, results: dirname(filename), name: 'ogc-tiles-browser' });
    assert.ok(frame.features.some(({ id }) => id === 'row-1'));
  });

  cli('access', 'revoke', privateId, '--email', email);
  await expectVisible(['observations', registeredId], bearer);
  await expectAccess(privateId, 403, bearer);
  await expectAccess(registeredId, 200, bearer);
});

test('CLI preserves a legacy Features provider at /tiles and rejects mixed protocols at that root', async () => {
  const features = {
    ...config.providers.tiles,
    api: { ...config.providers.tiles.api, protocol: 'features' },
  };
  const legacy = { ...config, providers: { features }, publications: {} };
  await writeFile(filename, stringify(legacy));
  cli('config', 'validate', filename);
  await writeFile(filename, stringify({ ...legacy, providers: { ...legacy.providers, tiles: config.providers.tiles } }));
  const rejected = spawnSync(process.execPath, ['dist/cli.js', 'config', 'validate', filename, '--json'],
    { encoding: 'utf8', windowsHide: true });
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 2);
  assert.match(JSON.parse(rejected.stdout).data.message, /Providers at '\/tiles' must use the same protocol/);
});
