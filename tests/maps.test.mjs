import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { auth, register, signIn } from './access-client.mjs';

const filename = process.env.GIS_TEST_CONFIG;
const origin = process.env.GIS_TEST_PUBLIC_URL;
const image = 'geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a';
const mapPath = '/maps/collections/control/map';
const rasterColors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];

function yaml() {
  return `schema_version: 1
server: {host: localhost, port: ${new URL(origin).port}}
sources:
  raster: {type: geotiff, path: map-control.tif}
providers:
  maps:
    type: pygeoapi
    image: ${image}
    api: {protocol: maps, scheme: http, port: 80, base_path: /, public_root: /maps, links: canonical, readiness: /openapi}
publications:
  control:
    source: raster
    provider: maps
    protocol: maps
    access: public
    title: Control raster
    description: Four colored quadrants
    extent: [10, 20, 14, 24]
`;
}

function cli(...args) {
  const child = spawnSync(process.execPath, ['dist/cli.js', ...args, '--json'], { encoding: 'utf8' });
  assert.ifError(child.error);
  return { status: child.status, result: JSON.parse(child.stdout) };
}

function apply(config) {
  writeFileSync(filename, config);
  const plan = cli('config', 'plan', filename);
  assert.equal(plan.status, 0, JSON.stringify(plan.result));
  const applied = cli('config', 'apply', plan.result.data.planId);
  assert.equal(applied.status, 0, JSON.stringify(applied.result));
  return plan.result.data;
}

async function get(path, parameters, status = 200, headers = {}) {
  const url = new URL(path, origin);
  url.search = new URLSearchParams(parameters);
  const response = await fetch(url, {
    headers: { Connection: 'close', ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, `${url} ${response.status === status ? '' : await response.text()}`);
  return response;
}

async function assertRasterPixels(response, width, height, colors) {
  assert.equal(response.headers.get('content-type'), 'image/png');
  const output = `map-${width}x${height}.png`;
  writeFileSync(join(dirname(filename), output), Buffer.from(await response.arrayBuffer()));
  const sample = spawnSync('docker', ['run', '--rm',
    '--mount', `type=bind,src=${dirname(filename)},dst=/results,readonly`,
    '--entrypoint', '/venv/bin/python', image, '-c', `
import json
from osgeo import gdal
image = gdal.Open('/results/${output}')
points = [(x, y) for y in (2, image.RasterYSize - 3) for x in (2, image.RasterXSize - 3)]
print(json.dumps([image.RasterXSize, image.RasterYSize, [list(image.ReadRaster(x, y, 1, 1)) for x, y in points]]))
`], { encoding: 'utf8' });
  assert.ifError(sample.error);
  assert.equal(sample.status, 0, sample.stderr);
  assert.deepEqual(JSON.parse(sample.stdout), [width, height, colors]);
}

test('public raster is advertised and renders the requested area and pixel dimensions', async () => {
  const plan = apply(yaml());
  assert.equal(plan.newUrl, `${origin}/maps/collections/control`);
  const catalog = await (await get('/maps/collections', { f: 'json' })).json();
  assert.deepEqual(catalog.collections.map(({ id }) => id), ['control']);
  assert.ok(catalog.collections[0].links.some(({ href, type }) => href === `${origin}${mapPath}?f=png` && type === 'image/png'));
  const collection = await (await get('/maps/collections/control', { f: 'json' })).json();
  assert.ok(collection.links.some(({ href, type }) => new URL(href).pathname === mapPath && type === 'image/png'));
  const api = await (await get('/maps/openapi', { f: 'json' })).json();
  assert.equal(api.servers[0].url, `${origin}/maps`);
  assert.ok(api.paths['/collections/control/map'].get.responses['200'].content['image/png']);
  const conformance = await (await get('/maps/conformance', { f: 'json' })).json();
  const spec = 'http://www.opengis.net/spec';
  assert.deepEqual(new Set(conformance.conformsTo), new Set([
    `${spec}/ogcapi-maps-1/1.0/conf/core`, `${spec}/ogcapi-common-2/1.0/conf/collections`,
    ...['core', 'landing-page', 'json', 'html', 'oas30'].map((name) => `${spec}/ogcapi-common-1/1.0/conf/${name}`),
  ]));
  await get('/maps/collections/control/items', {}, 404);
  for (const [bbox, width, height, colors] of [
    ['10,20,14,24', 47, 29, rasterColors],
    ['11,19,15,23', 29, 47, [[255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]],
  ]) {
    const response = await get(mapPath, { bbox, width, height });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.headers.get('content-bbox').split(',').map(Number), bbox.split(',').map(Number));
    assert.equal(response.headers.get('content-crs'), 'http://www.opengis.net/def/crs/OGC/1.3/CRS84');
    await assertRasterPixels(response, width, height, colors);
  }
});

test('map dimensions are bounded and invalid parameters return JSON errors', async () => {
  apply(yaml());
  for (const [query, name] of [
    [{ width: '0' }, 'width'],
    [{ height: '2049' }, 'height'],
    [{ height: '-1' }, 'height'],
    [{ width: '1.5' }, 'width'],
    [[['width', '256'], ['width', '257']], 'width'],
    [{ bbox: '10,20,14' }, 'bbox'],
    [{ bbox: '10,20,NaN,24' }, 'bbox'],
    [{ bbox: '14,20,10,24' }, 'bbox'],
    [{ bbox: '10,20,10,24' }, 'bbox'],
    [{ bbox: '10,20,14,91' }, 'bbox'],
    [{ f: 'jpeg' }, 'f'],
  ]) {
    const response = await get(mapPath, query, 400);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const error = await response.json();
    assert.equal(error.code, 'InvalidParameterValue');
    assert.ok(error.description.startsWith(name + ' '), JSON.stringify(error));
  }
  for (const [width, height] of [[1, 1], [2048, 2048]]) {
    const response = await get(mapPath, { bbox: '10,20,14,24', width, height });
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
  }
  const defaultMap = Buffer.from(await (await get(mapPath, {}, 200, { Accept: 'image/png' })).arrayBuffer());
  assert.equal(defaultMap.readUInt32BE(16), 500);
  assert.equal(defaultMap.readUInt32BE(20), 300);
  const pngOnly = await get(mapPath, { bbox: '10,20,14,24', width: 20, height: 20 }, 200,
    { Accept: 'application/json' });
  assert.equal(pngOnly.headers.get('content-type'), 'image/png');
  await pngOnly.arrayBuffer();
});

test('maps and features share the gateway while catalog and map access follow each publication', async () => {
  for (const name of ['auth-secret', 'postgres-password']) {
    writeFileSync(join(dirname(filename), name), randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const privatePath = '/maps/collections/private-map';
  const registeredPath = '/maps/collections/registered-map';
  const config = yaml().replace('providers:', `  projected: {type: cog, path: map-control.cog.tiff, epsg: 3857}
  places: {type: geojson, path: places.geojson}
providers:
  features: {type: pygeoapi}`) + `
  private-map:
    source: projected
    provider: maps
    protocol: maps
    access: private
    title: Private raster
    description: Projected COG
    extent: [10, 20, 14, 24]
  registered-map:
    source: projected
    provider: maps
    protocol: maps
    access: registered
    title: Registered raster
    description: Projected COG
    extent: [10, 20, 14, 24]
  places:
    source: places
    provider: features
    protocol: features
    access: public
    title: Places
    description: GeoJSON features
    extent: [30, 50, 40, 60]
auth:
  mode: development
  secret_file: auth-secret
  postgres_password_file: postgres-password
  mailpit_port: ${new URL(process.env.GIS_TEST_MAILPIT).port}
  cli:
    port: ${process.env.GIS_ADMIN_PORT}
    ca_file: ca.pem
    cert_file: server.pem
    key_file: server-key.pem
    operators:
      operator: [access-write]
`;
  writeFileSync(join(dirname(filename), 'places.geojson'), readFileSync('examples/places.geojson'));
  const plan = apply(config);
  assert.ok(plan.services.includes('pygeoapi') && plan.services.includes('provider-maps'), JSON.stringify(plan));
  await (await get('/features/collections/places/items', { f: 'json' })).json();
  const query = { bbox: '10.25,20.25,13.75,23.75', width: 128, height: 64 };
  const catalog = async (headers) => (await (await get('/maps/collections', { f: 'json' }, 200, headers)).json())
    .collections.map(({ id }) => id);
  const apiPaths = async (headers) => (await (await get('/maps/openapi', { f: 'json' }, 200, headers)).json()).paths;
  assert.deepEqual(await catalog(), ['control']);
  assert.equal((await apiPaths())['/collections/private-map/map'], undefined);
  await get(privatePath, { f: 'json' }, 401);
  await get(privatePath + '/map', { width: 0 }, 401);
  await get(registeredPath + '/map', query, 401);

  const email = 'maps-reader@example.test';
  const password = 'maps-reader-password-123';
  await register(email, password);
  const cookie = await signIn(email, password);
  assert.deepEqual(await catalog({ Cookie: cookie }), ['control', 'registered-map']);
  const registeredMap = await get(registeredPath + '/map', query, 200, { Cookie: cookie });
  await assertRasterPixels(registeredMap, 128, 64, rasterColors);
  await get(privatePath + '/map', query, 403, { Cookie: cookie });

  const grant = cli('access', 'grant', 'private-map', '--email', email);
  assert.equal(grant.status, 0, JSON.stringify(grant.result));
  const token = await auth('tokens/create', { name: 'Maps' }, cookie);
  assert.equal(token.status, 201);
  const { secret } = await token.json();
  const bearer = { Authorization: `Bearer ${secret}` };
  assert.deepEqual(await catalog(bearer), ['control', 'private-map', 'registered-map']);
  const paths = await apiPaths(bearer);
  assert.deepEqual(paths['/collections/private-map/map'].get.security, [{ session: [] }, { bearer: [] }]);
  const actual = await get(privatePath + '/map', query, 200, bearer);
  assert.equal(actual.headers.get('content-type'), 'image/png');
  await actual.arrayBuffer();
  const revoke = cli('access', 'revoke', 'private-map', '--email', email);
  assert.equal(revoke.status, 0, JSON.stringify(revoke.result));
  await get(privatePath + '/map', query, 403, bearer);
});

test('applying an unreadable raster leaves the active publication available', async () => {
  apply(yaml());
  writeFileSync(join(dirname(filename), 'invalid.tif'), 'This is not a TIFF');
  writeFileSync(filename, yaml().replace('map-control.tif', 'invalid.tif'));
  const plan = cli('config', 'plan', filename);
  assert.equal(plan.status, 0, JSON.stringify(plan.result));
  const applied = cli('config', 'apply', plan.result.data.planId);
  assert.equal(applied.status, 6, JSON.stringify(applied.result));
  assert.match(applied.result.data.message, /control.*raster/i);
  const image = await get(mapPath, { bbox: '10,20,14,24', width: 80, height: 30 });
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('config validate rejects invalid Maps sources, provider protocols and extents', () => {
  for (const [before, after, message] of [
    ['type: geotiff, path: map-control.tif', 'type: geojson, path: places.geojson', /unsupported by protocol 'maps'/],
    ['api: {protocol: maps', 'api: {protocol: features', /unsupported by provider 'maps'/],
    ['public_root: /maps', 'public_root: /other', /requires public_root \/maps/],
    ['[10, 20, 14, 24]', '[10, 20, 10, 24]', /invalid extent/],
    ['[10, 20, 14, 24]', '[10, 20, 14, 91]', /extent\/3/],
  ]) {
    writeFileSync(filename, yaml().replace(before, after));
    const validation = cli('config', 'validate', filename);
    assert.equal(validation.status, 2, JSON.stringify(validation.result));
    assert.match(validation.result.data.message, message);
  }
});
