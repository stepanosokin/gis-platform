import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

const gateway = process.env.GIS_TEST_GATEWAY;
const canonical = process.env.GIS_TEST_PUBLIC_URL;
const collection = '/features/collections/places';

async function get(path) {
  const url = new URL(path, gateway);
  return fetch(url, { signal: AbortSignal.timeout(10_000) });
}

async function getJson(path) {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
  return response.json();
}

test('the applied public GeoJSON publication returns the expected feature through Caddy', async () => {
  const response = await get(`${collection}/items/central?f=json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i);
  const feature = await response.json();
  assert.equal(feature.type, 'Feature');
  assert.equal(feature.id, 'central');
  assert.deepEqual(feature.geometry, { type: 'Point', coordinates: [37.62, 55.75] });
});

test('the applied public deployment has a home page with active links and no sign-in forms', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.ok(html.includes(`href="${canonical}/features/collections/places"`));
  assert.ok(html.includes(`href="${canonical}/features?f=html"`));
  assert.doesNotMatch(html, /\/account\/(login|register)/);
  assert.equal((await get('/platform-landing.html')).status, 404);
});

test('the public catalog and OpenAPI 3.0 use the external Features URL', async () => {
  const landing = await getJson('/features?f=json');
  const advertised = landing.links.find(({ rel, type }) => rel === 'service-desc' && type.includes('json'));
  const openApi = new URL(advertised.href);
  assert.equal(openApi.origin, canonical);
  assert.equal(openApi.pathname, '/features/openapi');

  const catalog = await getJson('/features/collections?f=json');
  assert.deepEqual(catalog.collections.map(({ id }) => id), ['places']);
  const details = await getJson(`${collection}?f=json`);
  const items = new URL(details.links.find(({ rel }) => rel === 'items').href);
  assert.equal(items.origin, canonical);
  assert.equal(items.pathname, `${collection}/items`);
  for (const relation of ['schema', 'queryables']) {
    const link = details.links.find(({ rel, type }) => rel.endsWith(`/${relation}`) && type === 'application/schema+json');
    const url = new URL(link.href);
    assert.equal(url.origin, canonical);
    assert.equal(url.pathname, `${collection}/${relation}`);
    await getJson(url.pathname + url.search);
  }

  const api = await getJson(openApi.pathname + openApi.search);
  assert.match(api.openapi, /^3\.0\./);
  assert.deepEqual(api.servers.map(({ url }) => url), [`${canonical}/features`]);
  assert.ok(api.paths['/collections/places/items']);

  const html = new URL(details.links.find(({ rel, type }) => rel === 'items' && type === 'text/html').href);
  assert.equal(html.origin, canonical);
  const itemsPage = await get(html.pathname + html.search);
  assert.equal(itemsPage.status, 200);
  assert.match(itemsPage.headers.get('content-type'), /^text\/html/);
  const stylesheet = /href="([^"]*\/static\/css\/default\.css)"/.exec(await itemsPage.text());
  assert.ok(stylesheet);
  const css = new URL(stylesheet[1], canonical);
  assert.equal(css.origin, canonical);
  const cssResponse = await get(css.pathname);
  assert.equal(cssResponse.status, 200);
  await cssResponse.body?.cancel();
});

test('the next page link returns the second page for the same publication', async () => {
  const first = await getJson(`${collection}/items?f=json&limit=1`);
  assert.deepEqual(first.features.map(({ id }) => id), ['central']);
  const next = new URL(first.links.find(({ rel }) => rel === 'next').href);
  assert.equal(next.origin, canonical);
  assert.equal(next.pathname, `${collection}/items`);
  const second = await getJson(next.pathname + next.search);
  assert.deepEqual(second.features.map(({ id }) => id), ['area/east']);
});

test('a feature is found by its ID and an absent feature returns 404', async () => {
  const found = await getJson(`${collection}/items/${encodeURIComponent('area/east')}?f=json`);
  assert.equal(found.id, 'area/east');
  assert.equal(found.properties.name, 'East');

  const absent = await get(`${collection}/items/missing?f=json`);
  assert.equal(absent.status, 404);
  assert.equal((await absent.json()).code, 'NotFound');
});

test('a bbox query returns the feature that intersects the given bounds', async () => {
  const within = await getJson(`${collection}/items?f=json&bbox=37,55,38,56`);
  assert.deepEqual(within.features.map(({ id }) => id), ['central']);
});

test('Caddy closes undeclared collections and internal routes', async () => {
  for (const path of [
    '/features/collections/unlisted/items',
    '/collections/places/items',
    '/features/asyncapi',
    '/features/admin',
  ]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    await response.body?.cancel();
  }
});

test('editing the YAML without config apply leaves the publication in service', async () => {
  const filename = '/results/platform.yaml';
  const original = await readFile(filename, 'utf8');
  assert.ok(original.includes('Example places'));
  await writeFile(filename, original.replace('Example places', 'Unapplied edit'));

  const details = await getJson(`${collection}?f=json`);
  assert.equal(details.title, 'Example places');
});
