import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const filename = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const port = new URL(gateway).port;
const crs84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
const epsg = (code) => `http://www.opengis.net/def/crs/EPSG/0/${code}`;
const esri = (code) => `http://www.opengis.net/def/crs/ESRI/0/${code}`;

function cli(...args) {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'config', ...args, '--json'], { encoding: 'utf8' });
  assert.ifError(result.error);
  return { status: result.status, result: JSON.parse(result.stdout) };
}

function yaml() {
  return `schema_version: 1
server: {host: localhost, port: ${port}}
sources:
  package: {type: geopackage, path: places.gpkg, layer: places, id_field: key}
providers:
  files: {type: pygeoapi}
publications:
  places:
    source: package
    provider: files
    protocol: features
    access: public
    title: Test places
    description: Test file publication
    extent: [36, 54, 40, 58]
`;
}

function apply(contents) {
  writeFileSync(filename, contents);
  const validate = cli('validate', filename);
  assert.equal(validate.status, 0, JSON.stringify(validate.result));
  const plan = cli('plan', filename);
  assert.equal(plan.status, 0, JSON.stringify(plan.result));
  const applied = cli('apply', plan.result.data.planId);
  assert.equal(applied.status, 0, JSON.stringify(applied.result));
}

function withShapefile() {
  return yaml().replace('providers:', `  shape: {type: shapefile, path: places-shape.shp, layer: places-shape, id_field: key}
providers:`) + yaml().split('  places:\n')[1].replace('source: package', 'source: shape')
    .replace(/^    source:/, '  shape-places:\n    source:');
}

async function get(path, params = {}, status = 200, root = '/features') {
  const url = new URL(root + path, gateway);
  url.search = new URLSearchParams({ f: 'json', ...params });
  const response = await fetch(url, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify({ url, body }));
  return { body, headers: response.headers };
}

test('GeoPackage publication serves stable feature IDs, bbox intersections and pages through Caddy', async () => {
  apply(yaml());

  const items = '/collections/places/items';
  const { body: point, headers } = await get(`${items}/reference`);
  assert.equal(point.id, 'reference');
  assert.deepEqual(point.geometry.coordinates, [37.62, 55.75]);
  assert.equal(headers.get('Content-Crs'), `<${crs84}>`);
  const first = await get(items, { limit: 1 });
  const next = first.body.links.find(({ rel }) => rel === 'next');
  assert.ok(next);
  const nextPage = await fetch(next.href, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000) });
  assert.deepEqual((await nextPage.json()).features.map(({ id }) => id), ['crossing']);
  const { body } = await get(items, { bbox: '38,55,39,56' });
  assert.deepEqual(body.features.map(({ id }) => id), ['crossing']);
  await get(`${items}/missing`, {}, 404);
});

test('one provider can publish GeoPackage and a Shapefile with separate sidecars and IDs', async () => {
  apply(withShapefile());
  const { body: catalog } = await get('/collections');
  assert.deepEqual(catalog.collections.map(({ id }) => id), ['places', 'shape-places']);
  const { body } = await get('/collections/shape-places/items/reference');
  assert.ok(Math.abs(body.geometry.coordinates[0] - 37.62) < 1e-9);
  assert.ok(Math.abs(body.geometry.coordinates[1] - 55.75) < 1e-9);
});

test('GeoParquet WKB returns explicit IDs and intersects a bbox that does not contain the feature', async () => {
  apply(yaml()
    .replace('type: geopackage, path: places.gpkg, layer: places', 'type: geoparquet, path: places.parquet')
    .replace('  places:\n', '  parquet-places:\n') + '    time_field: observed\n');
  const items = '/collections/parquet-places/items';
  const { body } = await get(items, { bbox: '38,55,39,56' });
  assert.deepEqual(body.features.map(({ id }) => id), ['crossing']);
  const { body: point } = await get(`${items}/reference`);
  assert.equal(point.id, 'reference');
  assert.deepEqual(point.geometry.coordinates, [37.62, 55.75]);
  const { body: inHole } = await get(items, { bbox: '38.7,56.7,39,57' });
  assert.deepEqual(inHole.features, []);
  const { body: polygon } = await get(`${items}/${encodeURIComponent('area/with-hole')}`);
  assert.equal(polygon.id, 'area/with-hole');
  assert.equal(polygon.geometry.type, 'Polygon');
  const { body: during } = await get(items, { datetime: '2026-01-02T00:00:00Z/..' });
  assert.deepEqual(during.features.map(({ id }) => id), ['crossing', 'area/with-hole', 'timeless']);
  const { body: rejectedFilter } = await get(items, { filter: "key = 'crossing'" }, 400);
  assert.match(rejectedFilter.description, /CQL2/);
  const { body: details } = await get('/collections/parquet-places');
  assert.match(details.description, /bbox.*datetime is supported.*CQL2 is unavailable/);
  const { body: api } = await get('/openapi');
  assert.ok(api.paths[items].get.parameters.some((entry) => entry.$ref?.endsWith('/parameters/datetime')));
  assert.equal(api.paths[items].post, undefined);
});

test('configured Features CRS are published and used for response and bbox coordinates', async () => {
  apply(yaml() + '    crs: [EPSG:3857, EPSG:4326, ESRI:102026, EPSG:5041, EPSG:32637]\n');
  const collection = '/collections/places';
  const items = `${collection}/items`;
  const expected = [
    [crs84, [37.62, 55.75]],
    [epsg(3857), [4187839.243643, 7508807.851302]],
    [epsg(4326), [55.75, 37.62]],
    [esri(102026), [-3136804.385804, 3872231.761575]],
    [epsg(5041), [4390058.918169, -1101314.735427]],
    [epsg(32637), [413380.720278, 6179118.146754]],
  ];
  const codes = expected.map(([code]) => code);
  const { body: metadata } = await get(collection);
  assert.deepEqual(metadata.crs, codes);
  const { body: catalog } = await get('/collections');
  assert.deepEqual(catalog.collections.find(({ id }) => id === 'places').crs, codes);
  const { body: conformance } = await get('/conformance');
  assert.ok(conformance.conformsTo.includes('http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs'));
  assert.ok(!conformance.conformsTo.some((uri) => /cql2|create-replace-delete/.test(uri)));
  const { body: api } = await get('/openapi');
  const item = api.paths[`${items}/{featureId}`].get;
  const list = api.paths[items].get;
  assert.ok(list.parameters.some((entry) => entry.name === 'bbox-crs' || entry.$ref?.endsWith('/bbox-crs')));
  assert.ok(!list.parameters.some((entry) => entry.name === 'sortby' || entry.$ref?.endsWith('/sortby')));
  const bboxParameter = list.parameters.find((entry) => entry.name === 'bbox');
  assert.equal(bboxParameter.schema.minItems, 4);
  assert.equal(bboxParameter.schema.maxItems, 4);
  assert.ok(item.parameters.some((entry) => entry.name === 'crs' || entry.$ref?.endsWith('/crs')));

  for (const [crs, coordinates] of expected) {
    const { body: point, headers } = await get(`${items}/reference`, { crs });
    assert.equal(headers.get('Content-Crs'), `<${crs}>`);
    point.geometry.coordinates.forEach((value, axis) =>
      assert.ok(Math.abs(value - coordinates[axis]) < 0.01, `${crs}, axis ${axis}: ${value}`));
    const margin = crs === crs84 || crs === epsg(4326) ? 0.01 : 100;
    const [x, y] = coordinates;
    const { body, headers: listHeaders } = await get(items, {
      'bbox-crs': crs, bbox: [x - margin, y - margin, x + margin, y + margin].join(','),
      crs: epsg(4326),
    });
    assert.equal(listHeaders.get('Content-Crs'), `<${epsg(4326)}>`);
    assert.deepEqual(body.features.map(({ id }) => id), ['reference'], crs);
    assert.deepEqual(body.features[0].geometry.coordinates, [55.75, 37.62]);
  }
  const { body: wrongAxes } = await get(items, { 'bbox-crs': epsg(4326), bbox: '37,55,38,56' });
  assert.deepEqual(wrongAxes.features, []);
  await get(items, { 'bbox-crs': epsg(4326) }, 400);
  await get(items, { 'bbox-crs': epsg(32638), bbox: '0,0,1,1' }, 400);
  await get(`${items}/reference`, { crs: epsg(32638) }, 400);
});

test('apply identifies a configured CRS that the provider cannot transform', async () => {
  writeFileSync(filename, yaml() + '    crs: [EPSG:99999999]\n');
  const plan = cli('plan', filename);
  assert.equal(plan.status, 0, JSON.stringify(plan.result));
  const applied = cli('apply', plan.result.data.planId);
  assert.equal(applied.status, 6, JSON.stringify(applied.result));
  assert.match(applied.result.data.message, /places.*EPSG\/0\/99999999.*unsupported/i);
  writeFileSync(filename, yaml().replace('type: geopackage, path: places.gpkg, layer: places, id_field: key',
    'type: geojson, path: places.geojson') + '    crs: [ESRI:102026]\n');
  const invalid = cli('validate', filename);
  assert.equal(invalid.status, 2);
  assert.match(invalid.result.data.message, /places.*ESRI:102026.*unsupported for geojson bbox/);
});

test('removing a Shapefile sidecar after planning rejects the plan and leaves the active publication available', async () => {
  apply(yaml());
  writeFileSync(filename, withShapefile());
  const proposed = cli('plan', filename);
  assert.equal(proposed.status, 0, JSON.stringify(proposed.result));
  const sidecar = join(dirname(filename), 'places-shape.dbf');
  renameSync(sidecar, sidecar + '.pending');
  try {
    const failed = cli('apply', proposed.result.data.planId);
    assert.equal(failed.status, 6, JSON.stringify(failed.result));
    assert.match(failed.result.data.message, /shape.*sidecar.*unavailable/i);
    const { body: catalog } = await get('/collections');
    assert.deepEqual(catalog.collections.map(({ id }) => id), ['places']);
    await get('/collections/places/items/reference');
  } finally {
    renameSync(sidecar + '.pending', sidecar);
  }
});

test('an unchanged provider with an unavailable input does not block a different provider', async () => {
  const mixed = withShapefile().replace('publications:', `  packages:
    type: pygeoapi
    image: geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a
    api: {protocol: features, scheme: http, port: 80, base_path: /, public_root: /more-features, links: canonical, readiness: /openapi}
publications:`).replace('source: package\n    provider: files', 'source: package\n    provider: packages');
  apply(mixed);
  const sidecar = join(dirname(filename), 'places-shape.dbf');
  renameSync(sidecar, sidecar + '.pending');
  try {
    apply(mixed.replace('title: Test places', 'title: Updated package'));
    const { body } = await get('/collections/places', {}, 200, '/more-features');
    assert.equal(body.title, 'Updated package');
  } finally {
    renameSync(sidecar + '.pending', sidecar);
  }
});
