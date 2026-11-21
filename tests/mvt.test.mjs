import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { stringify } from 'yaml';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader, PbfWriter } from 'pbf';
import { auth, register, signIn } from './access-client.mjs';
import { mapLibreBrowserOptions, renderMapLibre } from './maplibre-browser.mjs';
import { renderMvt } from './mvt-browser.mjs';
import { solidPng, writeMbtiles } from './raster-tile-fixtures.mjs';

const filename = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const project = process.env.COMPOSE_PROJECT_NAME;
const database = `${project}-external-postgis`;
const otherDatabase = `${project}-other-postgis`;
const martin = 'ghcr.io/maplibre/martin:1.16.1@sha256:59902019bf9038926ff0c71174237d6852e64c457830a6349abe7090be8818ca';

function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function docker(...args) {
  return command('docker', args);
}

function martinContainer() {
  return docker('ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=provider-martin-east');
}

async function waitForDatabase(container = database) {
  for (let attempt = 0; ; attempt++) {
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
      { encoding: 'utf8', windowsHide: true });
    if (ready.status === 0) return;
    assert.ok(attempt < 40, ready.stdout || ready.stderr);
    await setTimeout(500);
  }
}

function sql(statement, container = database) {
  return command('docker', ['exec', '-i', container, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], statement);
}

function cli(...args) {
  return JSON.parse(command(process.execPath, ['dist/cli.js', ...args, '--json'])).data;
}

function invalidConfig(message) {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'config', 'validate', filename, '--json'],
    { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stdout);
  assert.match(JSON.parse(result.stdout).data.message, message);
}

async function request(path, expected = 200, options) {
  const response = await fetch(gateway + path, {
    ...options, headers: { Connection: 'close', ...options?.headers }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, `${path}: ${response.status}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
}

function preflight(origin) {
  return { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
  } };
}

async function waitForPort(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function testGlyphs() {
  const writer = new PbfWriter();
  writer.writeMessage(1, (_, stack) => {
    stack.writeStringField(1, 'Test Sans,Test Fallback');
    stack.writeStringField(2, '0-255');
    stack.writeMessage(3, (_, glyph) => {
      glyph.writeVarintField(1, 'X'.codePointAt(0));
      glyph.writeBytesField(2, Buffer.alloc(14 * 14, 240));
      glyph.writeVarintField(3, 8);
      glyph.writeVarintField(4, 8);
      glyph.writeSVarintField(5, 0);
      glyph.writeSVarintField(6, 8);
      glyph.writeVarintField(7, 8);
    }, null);
  }, null);
  return writer.finish();
}

async function features(path, publication, options) {
  const tile = await request(path, 200, options);
  assert.match(tile.headers.get('content-type'), /(?:application\/vnd\.mapbox-vector-tile|application\/x-protobuf)/);
  const { layers } = new VectorTile(new PbfReader(new Uint8Array(await tile.arrayBuffer())));
  const layer = layers[publication];
  assert.equal(layer.version, 2);
  return Array.from({ length: layer.length }, (_, i) => layer.feature(i));
}

test('Martin publishes explicit PostGIS sources through canonical gateway URLs', async (t) => {
  const network = `${project}_default`;
  docker('network', 'create', '--label', `com.docker.compose.project=${project}`,
    '--label', 'com.docker.compose.network=default', network);
  const started = [];
  t.after(() => {
    try {
      if (started.length) docker('rm', '-f', '-v', ...started);
    } finally {
      docker('compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f', 'compose.mailpit.yaml',
        'down', '--remove-orphans', '--volumes');
    }
  });
  const adminFile = join(dirname(filename), 'db-password');
  const readerFile = join(dirname(filename), 'reader-password');
  const readerPassword = randomBytes(24).toString('hex') + ':@/%$';
  await writeFile(adminFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  await writeFile(readerFile, readerPassword + '\n', { mode: 0o600 });
  const authFiles = {};
  for (const name of ['secret_file', 'postgres_password_file']) {
    authFiles[name] = join(dirname(filename), `auth-${name}`);
    await writeFile(authFiles[name], randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const browserServer = createServer();
  const browserPort = await waitForPort(browserServer);
  await new Promise((resolve) => browserServer.close(resolve));
  const browserOrigin = `http://127.0.0.1:${browserPort}`;
  for (const [container, alias] of [[database, 'external-postgis'], [otherDatabase, 'other-postgis']]) {
    docker('run', '-d', '--name', container, '--network', network, '--network-alias', alias,
      '--mount', `type=bind,src=${adminFile},dst=/run/secrets/password,readonly`,
      '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/password',
      'postgis/postgis:18-3.6@sha256:4a43e3c3e5d55b9208240fc71db543b79c638766280c625a425bd0a2390989c4');
    started.push(container);
  }
  await Promise.all(started.map(waitForDatabase));
  const setup = `
    CREATE ROLE gis_reader LOGIN PASSWORD '${readerPassword}';
    CREATE SCHEMA gis;
    CREATE TABLE gis.observations (id text PRIMARY KEY, label text NOT NULL, geom geometry(Point, 4326) NOT NULL);
    CREATE VIEW gis."Published observations" AS
      SELECT *, current_setting('transaction_read_only') AS connection_mode FROM gis.observations;
    CREATE VIEW gis.unlisted AS SELECT * FROM gis.observations;
    GRANT USAGE ON SCHEMA gis TO gis_reader;
    GRANT SELECT ON gis."Published observations", gis.unlisted TO gis_reader;
    COMMENT ON VIEW gis."Published observations" IS '{"tiles":["http://example.invalid/hidden/{z}/{x}/{y}"]}';
    INSERT INTO gis.observations VALUES ('row-1', 'Greenwich', ST_SetSRID(ST_MakePoint(1, 1), 4326));
  `;
  sql(setup);
  sql(setup + "UPDATE gis.observations SET label = 'Independent PostGIS';", otherDatabase);
  const publication = { provider: 'martin-east', source: 'observations', protocol: 'mvt', access: 'public',
    title: 'Observations', description: 'Known PostGIS points', extent: [-180, -85, 180, 85],
    mvt_properties: ['label', 'connection_mode'],
    freshness: { max_delay_seconds: 0 } };
  const platform = {
    schema_version: 1,
    server: { host: 'localhost', port: Number(new URL(gateway).port) },
    cors: { allowed_origins: [browserOrigin, 'https://maps.example.test', 'http://[::1]:5173'] },
    auth: { mode: 'development', mailpit_port: Number(new URL(process.env.GIS_TEST_MAILPIT).port), ...authFiles,
      cli: { port: Number(process.env.GIS_ADMIN_PORT), ca_file: 'ca.pem', cert_file: 'server.pem',
        key_file: 'server-key.pem', operators: { operator: ['access-write', 'diagnostics'] } } },
    sources: { observations: { type: 'postgis', schema: 'gis', relation: 'Published observations', id_field: 'id',
      geometry_field: 'geom', max_lag_seconds: 0 }, control: { type: 'geojson', path: join(process.cwd(), 'examples', 'places.geojson') } },
    providers: { 'control-features': { type: 'pygeoapi' }, 'martin-east': {
      type: 'martin', image: martin,
      api: { protocol: 'mvt', scheme: 'http', port: 3000, base_path: '/', public_root: '/mvt',
        links: 'canonical', readiness: '/health' },
      postgis: { host: 'external-postgis', database: 'postgres', user: 'gis_reader', password_file: readerFile },
    } },
    publications: { observations: publication, 'observations-copy': { ...publication, access: 'registered' },
      control: { protocol: 'features', provider: 'control-features', source: 'control', access: 'public',
        title: 'Control', description: 'Independent file source', extent: [-180, -85, 180, 85] } },
  };
  await writeFile(filename, stringify(platform));
  cli('config', 'validate', filename);
  const plan = cli('config', 'plan', filename);
  assert.equal(plan.newUrl, gateway + '/mvt/observations');
  cli('config', 'apply', plan.planId);

  const tilejson = await (await request('/mvt/observations?example=ignored', 200, {
    headers: { 'X-Rewrite-URL': 'http://example.invalid/', Forwarded: 'host=example.invalid;proto=https' },
  })).json();
  assert.deepEqual(tilejson.tiles, [gateway + '/mvt/observations/{z}/{x}/{y}']);
  assert.equal(tilejson.scheme ?? 'xyz', 'xyz');
  assert.equal(tilejson.vector_layers[0].id, 'observations');
  const published = await features('/mvt/observations/1/1/0', 'observations');
  assert.equal(published.length, 1);
  assert.deepEqual({ ...published[0].properties }, { id: 'row-1', label: 'Greenwich', connection_mode: 'on' });
  const point = published[0].toGeoJSON(1, 0, 1).geometry.coordinates;
  assert.ok(Math.abs(point[0] - 1) < 0.05 && Math.abs(point[1] - 1) < 0.05);
  for (const path of ['/mvt', '/mvt/health', '/mvt/catalog', '/mvt/unlisted', '/mvt/unlisted/1/1/0',
    '/mvt/observations,observations-copy', '/mvt/observations%2Cobservations-copy/1/1/0',
    '/mvt/observations/1/1/0/extra', '/mvt/observations/1/1/0.png']) {
    const response = await fetch(gateway + path);
    assert.equal(response.status, 404, path);
  }
  const id = martinContainer();
  assert.ok(id);
  assert.deepEqual(JSON.parse(docker('inspect', '--format', '{{json .HostConfig.PortBindings}}', id)) ?? {}, {});

  await t.test('an authorized MapLibre origin can read both linked requests', async (t) => {
    const hidden = '/mvt/observations-copy';
    const tile = hidden + '/1/1/0';
    await request(hidden, 401);
    await request(tile, 401);
    const preflight = await request(tile, 204, { method: 'OPTIONS', headers: {
      Origin: browserOrigin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), browserOrigin);
    assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
    assert.equal(await preflight.text(), '');
    const ipv6 = 'http://[::1]:5173';
    const local = await request(tile, 204, { method: 'OPTIONS', headers: {
      Origin: ipv6, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    } });
    assert.equal(local.headers.get('access-control-allow-origin'), ipv6);
    const denied = await request(tile, 401, { headers: { Origin: 'http://example.invalid' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const email = 'mvt-reader@example.test';
    const password = randomBytes(24).toString('hex');
    await register(email, password);
    const cookie = await signIn(email, password);
    const token = await auth('tokens/create', { name: 'MVT' }, cookie);
    assert.equal(token.status, 201);
    const { secret } = await token.json();
    const headers = { Origin: browserOrigin, Authorization: `Bearer ${secret}` };
    const metadata = await request(hidden, 200, { headers: { ...headers, Accept: 'application/json' } });
    assert.equal(metadata.headers.get('access-control-allow-origin'), browserOrigin);
    assert.deepEqual((await metadata.json()).tiles, [gateway + hidden + '/{z}/{x}/{y}']);
    assert.equal((await features(tile, 'observations-copy', { headers }))[0].properties.label, 'Greenwich');
    await t.test('MapLibre GL JS renders the updated feature after COMMIT', mapLibreBrowserOptions, async () => {
      await renderMvt({ origin: browserOrigin, source: gateway + hidden, layer: 'observations-copy', secret,
        results: dirname(filename), afterFirstRender: () => {
          sql("BEGIN; UPDATE gis.observations SET label = 'Greenwich after COMMIT' WHERE id = 'row-1'; COMMIT;");
        } });
    });
  });

  await t.test('a configured MapLibre style uses the canonical TileJSON URL', async () => {
    const stylePath = '/mvt/observations/style.json';
    await request(stylePath, 404);
    const file = join(dirname(filename), 'observations-style.json');
    const original = {
      version: 8, name: 'Original observations',
      sources: { points: { type: 'vector', url: './' } },
      layers: [{ id: 'points', type: 'circle', source: 'points', 'source-layer': 'observations' }],
    };
    await writeFile(file, JSON.stringify(original));
    const { cors, ...defaultPlatform } = platform;
    await writeFile(filename, stringify({
      ...defaultPlatform, publications: { ...platform.publications,
        observations: { ...publication, maplibre: { style_file: 'observations-style.json' } } },
    }));
    cli('config', 'validate', filename);
    const originalPlan = cli('config', 'plan', filename);
    await writeFile(file, JSON.stringify({ ...original, name: 'Updated observations' }));
    cli('config', 'apply', originalPlan.planId);
    const style = await (await request(stylePath)).json();
    assert.equal(style.name, 'Original observations');
    assert.equal(style.sources.points.url, gateway + '/mvt/observations');
    const allowed = await request(stylePath, 204, preflight(gateway));
    assert.equal(allowed.headers.get('access-control-allow-origin'), gateway);
    assert.equal(await allowed.text(), '');
    const denied = await request(stylePath, 404, preflight(browserOrigin));
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const access = docker('ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=access');
    assert.ok(access);
    docker('stop', access);
    try {
      assert.equal((await (await request(stylePath)).json()).name, 'Original observations');
    } finally {
      docker('start', access);
    }
    const update = cli('config', 'plan', filename);
    assert.deepEqual(update.changed, ['observations']);
    cli('config', 'apply', update.planId);
    assert.equal((await (await request(stylePath)).json()).name, 'Updated observations');
    cli('config', 'apply', cli('config', 'plan', '--rollback-to', originalPlan.planId).planId);
    assert.equal((await (await request(stylePath)).json()).name, 'Original observations');

    await writeFile(file, JSON.stringify({
      ...original, sources: { points: { type: 'vector', url: 'https://other.example.test/tiles' } },
    }));
    invalidConfig(/TileJSON URLs must reference this publication/);
    await writeFile(file, JSON.stringify(original));
    await writeFile(filename, stringify({
      ...platform, publications: { ...platform.publications,
        observations: { ...publication, maplibre: { style_file: 'observations-style.json',
          resources: { 'Fonts/first.pbf': 'first.pbf', 'fonts/second.pbf': 'second.pbf' } } },
      },
    }));
    invalidConfig(/resource paths .* differ only in case/);
    await writeFile(filename, stringify({
      ...platform, publications: { ...platform.publications,
        con: { ...publication, maplibre: { style_file: 'observations-style.json' } },
      },
    }));
    invalidConfig(/publication ID usable as a file name/);
    cli('config', 'apply', cli('config', 'plan', '--rollback-to', plan.planId).planId);
    await request(stylePath, 404);
  });

  await t.test('the gateway protects every MapLibre style request and checks current grants and tokens', async (t) => {
    const id = 'styled-observations';
    const root = `/mvt/${id}`;
    const style = {
      version: 8,
      sprite: './resources/markers',
      glyphs: 'resources/fonts/{fontstack}/{range}.pbf',
      sources: {
        points: { type: 'vector', url: './' },
        related: { type: 'geojson', data: 'resources/reference.geojson' },
      },
      layers: [
        { id: 'observations', type: 'symbol', source: 'points', 'source-layer': id,
          layout: { 'icon-image': 'marker', 'icon-allow-overlap': true } },
        { id: 'labels', type: 'symbol', source: 'related',
          layout: { 'text-field': 'X', 'text-font': ['Test Sans', 'Test Fallback'], 'text-allow-overlap': true } },
        { id: 'reference', type: 'circle', source: 'related' },
      ],
    };
    const paths = [root, `${root}/1/1/0`, `${root}/style.json`, ...[
      'markers.png', 'markers.json', 'markers@2x.png', 'markers@2x.json', 'reference.geojson',
      'fonts/Test%20Sans,Test%20Fallback/0-255.pbf',
    ].map((name) => `${root}/resources/${name}`)];
    const styleFile = join(dirname(filename), 'private-style.json');
    const referenceFile = join(dirname(filename), 'reference.geojson');
    await writeFile(styleFile, JSON.stringify(style));
    await writeFile(join(dirname(filename), 'markers.png'), solidPng([220, 31, 71]));
    await writeFile(join(dirname(filename), 'test-glyphs.pbf'), testGlyphs());
    await writeFile(join(dirname(filename), 'markers.json'), JSON.stringify({
      marker: { x: 0, y: 0, width: 18, height: 18, pixelRatio: 1 },
    }));
    await writeFile(join(dirname(filename), 'markers@2x.json'), JSON.stringify({
      marker: { x: 0, y: 0, width: 36, height: 36, pixelRatio: 2 },
    }));
    const reference = { type: 'Feature', geometry: { type: 'Point', coordinates: [1.2, 1.2] },
      properties: { id: 'map-reference' } };
    await writeFile(referenceFile, JSON.stringify(reference));
    const configured = { ...platform, publications: { ...platform.publications,
      [id]: { ...publication, access: 'private', maplibre: {
        style_file: 'private-style.json',
        resources: { 'markers.png': 'markers.png', 'markers.json': 'markers.json',
          'markers@2x.png': 'markers.png', 'markers@2x.json': 'markers@2x.json',
          'reference.geojson': 'reference.geojson', 'fonts/Test Sans,Test Fallback/0-255.pbf': 'test-glyphs.pbf' },
      } },
    } };
    await writeFile(filename, stringify(configured));
    const styledPlan = cli('config', 'plan', filename);
    cli('config', 'apply', styledPlan.planId);
    const other = createServer();
    const disallowedOrigin = `http://127.0.0.1:${await waitForPort(other)}`;
    await new Promise((resolve) => other.close(resolve));
    for (const path of paths) {
      const response = await request(path, 204, preflight(browserOrigin));
      assert.equal(response.headers.get('access-control-allow-origin'), browserOrigin);
      assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization');
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
      assert.equal(await response.text(), '');
      const denied = await request(path, 404, preflight(disallowedOrigin));
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
      assert.match(denied.headers.get('vary'), /\bOrigin\b/i);
      const anonymous = await request(path, 401, { headers: { Origin: browserOrigin } });
      assert.equal(anonymous.headers.get('access-control-allow-origin'), browserOrigin);
    }
    const account = await fetch(gateway + '/api/auth/sign-in/email', preflight(browserOrigin));
    assert.equal(account.headers.get('access-control-allow-origin'), null);
    const email = 'styled-map-reader@example.test';
    const password = randomBytes(24).toString('hex');
    await register(email, password);
    const cookie = await signIn(email, password);
    const created = await auth('tokens/create', { name: 'Styled map' }, cookie);
    assert.equal(created.status, 201);
    const { secret, id: tokenId } = await created.json();
    const bearer = { Origin: browserOrigin, Authorization: `Bearer ${secret}` };
    async function verifyAccess(status, headers = bearer) {
      for (const path of paths) {
        const response = await request(path, status, { headers });
        await response.body?.cancel();
      }
    }
    await verifyAccess(403);
    cli('access', 'grant', id, '--email', email);
    await verifyAccess(200);
    const canonical = await (await request(paths[2], 200, { headers: bearer })).json();
    assert.equal(canonical.sources.points.url, gateway + root);
    assert.equal(canonical.sources.related.data, `${gateway}${root}/resources/reference.geojson`);
    assert.equal(canonical.sprite, `${gateway}${root}/resources/markers`);
    assert.equal(canonical.glyphs, `${gateway}${root}/resources/fonts/{fontstack}/{range}.pbf`);
    const blocked = await request(paths[2], 200, { headers: { ...bearer, Origin: disallowedOrigin } });
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
    await request(`${root}/resources/unlisted.png`, 404, { headers: bearer });

    await t.test('Chrome loads the linked map and sees grant revocation in the same browser', mapLibreBrowserOptions, async () => {
      const fixture = { paths: paths.map((path) => gateway + path), root: gateway + root, style: gateway + paths[2], secret };
      const script = `
        const fixture = ${JSON.stringify(fixture)};
        const headers = { Authorization: 'Bearer ' + fixture.secret };
        const requested = new Set();
        const map = new Map({
          container: 'map', center: [1, 1], zoom: 5, pixelRatio: 2, attributionControl: false, style: fixture.style,
          transformRequest: (url) => {
            if (url !== fixture.root && !url.startsWith(fixture.root + '/')) return { url };
            requested.add(url);
            return { url, headers };
          },
        });
        await new Promise((resolve, reject) => {
          map.once('error', ({ error }) => reject(error));
          map.once('idle', resolve);
        });
        const images = map.listImages();
        const rendered = map.queryRenderedFeatures({ layers: ['observations', 'reference', 'labels'] })
          .map(({ properties, layer }) => ({ id: properties.id, layer: layer.id }));
        await report({ images, rendered, requested: [...requested] });
        const statuses = await Promise.all(fixture.paths.map(async (url) => (await fetch(url, { headers })).status));
        map.remove();
        await report({ statuses });`;
      const [loaded, revoked] = await renderMapLibre({ origin: browserOrigin, results: dirname(filename),
        name: 'protected-maplibre', script, frameCount: 2,
        afterFirstRender: () => cli('access', 'revoke', id, '--email', email) });
      assert.ok(loaded.images.includes('marker'));
      assert.ok(loaded.rendered.some(({ id, layer }) => id === 'row-1' && layer === 'observations'));
      assert.ok(loaded.rendered.some(({ id, layer }) => id === 'map-reference' && layer === 'reference'));
      assert.ok(loaded.rendered.some(({ id, layer }) => id === 'map-reference' && layer === 'labels'));
      for (const path of [paths[0], ...paths.slice(2)].filter((path) => !/markers\.(png|json)$/.test(path))) {
        assert.ok(loaded.requested.some((url) => decodeURIComponent(url) === decodeURIComponent(gateway + path)), path);
      }
      assert.ok(loaded.requested.some((url) => /^\/mvt\/styled-observations\/\d+\/\d+\/\d+$/.test(new URL(url).pathname)));
      assert.deepEqual(revoked.statuses, paths.map(() => 403));
      cli('access', 'grant', id, '--email', email);
      const deniedScript = `
        const fixture = ${JSON.stringify(fixture)};
        const map = new Map({
          container: 'map', style: fixture.style,
          transformRequest: (url) => url === fixture.style
            ? { url, headers: { Authorization: 'Bearer ' + fixture.secret } } : { url },
        });
        const reason = await new Promise((resolve) => {
          map.once('error', ({ error }) => resolve(error.message));
          map.once('load', () => resolve(null));
        });
        map.remove();
        await report({ reason });`;
      const [denied] = await renderMapLibre({ origin: disallowedOrigin, results: dirname(filename),
        name: 'disallowed-maplibre', script: deniedScript, frameCount: 1 });
      assert.match(denied.reason, /Failed to fetch/);
    });

    cli('access', 'revoke', id, '--email', email);
    await verifyAccess(403);
    cli('access', 'grant', id, '--email', email);
    assert.equal((await auth('tokens/revoke', { id: tokenId }, cookie)).status, 204);
    await verifyAccess(401);
    cli('config', 'apply', cli('config', 'plan', '--rollback-to', plan.planId).planId);
    await request(`${root}/style.json`, 404);
  });

  await t.test('the same XYZ URL reflects committed inserts, updates and deletes', async () => {
    const path = '/mvt/observations/2/0/1';
    assert.equal((await request(path, 204)).body, null);
    sql(`BEGIN;
      INSERT INTO gis.observations VALUES ('row-fresh', 'New point', ST_SetSRID(ST_MakePoint(-135, 45), 4326));
      COMMIT;`);
    assert.equal((await features(path, 'observations'))[0].properties.label, 'New point');
    sql("UPDATE gis.observations SET label = 'Updated point' WHERE id = 'row-fresh';");
    assert.equal((await features(path, 'observations'))[0].properties.label, 'Updated point');
    sql("DELETE FROM gis.observations WHERE id = 'row-fresh';");
    assert.equal((await request(path, 204)).body, null);
  });

  await t.test('validation rejects a freshness budget below the source lag', async () => {
    await writeFile(filename, stringify({
      ...platform, sources: { ...platform.sources, observations: { ...platform.sources.observations, max_lag_seconds: 1 } },
    }));
    invalidConfig(/max_lag_seconds exceeds freshness\.max_delay_seconds/);
  });

  await t.test('a failed PostGIS preflight keeps the active gateway open', async () => {
    const invalidFile = join(dirname(filename), 'incorrect-reader-password');
    await writeFile(invalidFile, randomBytes(24).toString('hex'), { mode: 0o600 });
    const provider = platform.providers['martin-east'];
    await writeFile(filename, stringify({
      ...platform, providers: { ...platform.providers,
        'martin-east': { ...provider, postgis: { ...provider.postgis, password_file: invalidFile } } },
    }));
    const invalid = cli('config', 'plan', filename);
    const child = spawn(process.execPath, ['dist/cli.js', 'config', 'apply', invalid.planId, '--json'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const statuses = [];
    while (child.exitCode === null && child.signalCode === null) {
      const result = await fetch(gateway + '/mvt/observations', { headers: { Connection: 'close' },
        signal: AbortSignal.timeout(5_000) }).catch(() => null);
      statuses.push(result?.status);
      await result?.body?.cancel();
      await setTimeout(100);
    }
    assert.equal(await exited, 6, stdout);
    assert.match(JSON.parse(stdout).data.message, /Martin provider .* failed to open its PostGIS sources/);
    assert.ok(statuses.length && statuses.every((status) => status === 200), JSON.stringify(statuses));
    assert.equal((await features('/mvt/observations/1/1/0', 'observations'))[0].properties.id, 'row-1');
  });

  await t.test('TileJSON preflight rejects external resource extensions from source comments', async () => {
    sql(`CREATE VIEW gis.unsupported_metadata AS SELECT * FROM gis.observations;
      GRANT SELECT ON gis.unsupported_metadata TO gis_reader;
      COMMENT ON VIEW gis.unsupported_metadata IS '{"data":["http://example.invalid/internal.geojson"]}';`);
    await writeFile(filename, stringify({
      ...platform,
      sources: { ...platform.sources, extra: { ...platform.sources.observations, relation: 'unsupported_metadata' } },
      publications: { ...platform.publications,
        extra: { ...publication, source: 'extra', mvt_properties: ['label'] } },
    }));
    const invalid = cli('config', 'plan', filename);
    const result = spawnSync(process.execPath, ['dist/cli.js', 'config', 'apply', invalid.planId, '--json'], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 6, result.stdout);
    assert.match(JSON.parse(result.stdout).data.message, /Martin provider .* failed to open its PostGIS sources/);
    await request('/mvt/extra', 404);
  });

  await t.test('moving to another Martin instance preserves publication URLs and access', async () => {
    const provider = platform.providers['martin-east'];
    const moved = {
      ...platform,
      providers: { 'control-features': platform.providers['control-features'],
        'martin-west': { ...provider, api: { ...provider.api, base_path: '/native', port: 3005 } } },
      publications: Object.fromEntries(Object.entries(platform.publications).map(([id, entry]) =>
        [id, entry.protocol === 'mvt' ? { ...entry, provider: 'martin-west' } : entry])),
    };
    await writeFile(filename, stringify(moved));
    const candidate = cli('config', 'plan', filename);
    assert.equal(candidate.newUrl, plan.newUrl);
    cli('config', 'apply', candidate.planId);
    assert.deepEqual((await (await request('/mvt/observations')).json()).tiles,
      [gateway + '/mvt/observations/{z}/{x}/{y}']);
    await request('/mvt/observations-copy', 401);
    const rollback = cli('config', 'plan', '--rollback-to', plan.planId);
    cli('config', 'apply', rollback.planId);
    assert.equal((await features('/mvt/observations/1/1/0', 'observations'))[0].properties.id, 'row-1');
  });

  await t.test('removing the last MVT publication leaves the configured instance dormant until rollback', async () => {
    await writeFile(filename, stringify({ ...platform, publications: { control: platform.publications.control } }));
    const remove = cli('config', 'plan', filename);
    cli('config', 'apply', remove.planId);
    assert.equal(martinContainer(), '');
    await request('/mvt/observations', 404);
    await request('/features/collections/control?f=json');
    const rollback = cli('config', 'plan', '--rollback-to', plan.planId);
    cli('config', 'apply', rollback.planId);
    assert.equal((await features('/mvt/observations/1/1/0', 'observations'))[0].properties.id, 'row-1');
  });

  const archiveTile = solidPng([214, 57, 49]);
  const withArchive = { ...platform,
    sources: { ...platform.sources, 'file-tile': { type: 'mbtiles', path: './isolated.mbtiles' } },
    providers: { ...platform.providers, archives: { type: 'martin', image: martin, api: platform.providers['martin-east'].api },
      'martin-other': { ...platform.providers['martin-east'],
        postgis: { ...platform.providers['martin-east'].postgis, host: 'other-postgis' } } },
    publications: { ...platform.publications, 'other-observations': { ...publication, provider: 'martin-other' },
      'file-tile': { source: 'file-tile', provider: 'archives', protocol: 'mvt',
      access: 'public', title: 'Archive tile', description: 'Independent archive source', extent: [-180, -85, 180, 85] } },
  };
  await t.test('the archive and two external databases use independent Martin instances at /mvt', async () => {
    const existing = martinContainer();
    writeMbtiles(join(dirname(filename), 'isolated.mbtiles'), archiveTile);
    await writeFile(filename, stringify(withArchive));
    const archive = cli('config', 'plan', filename);
    assert.ok(archive.services.includes('provider-archives'));
    assert.ok(!archive.services.includes('provider-martin-east'));
    cli('config', 'apply', archive.planId);
    assert.equal(martinContainer(), existing);
    assert.equal((await features('/mvt/observations/1/1/0', 'observations'))[0].properties.id, 'row-1');
    assert.equal((await features('/mvt/other-observations/1/1/0', 'other-observations'))[0].properties.label,
      'Independent PostGIS');
    assert.deepEqual(Buffer.from(await (await request('/mvt/file-tile/0/0/0')).arrayBuffer()), archiveTile);
  });

  await t.test('confirmed Martin routes recover after a cold start with PostGIS offline', async () => {
    const tile = '/mvt/observations/1/1/0';
    const file = '/mvt/file-tile/0/0/0';
    const openapi = '/features/openapi?f=json';
    const before = await (await request(openapi)).json();
    const containers = docker('ps', '-q', '--filter', `label=com.docker.compose.project=${project}`).split(/\s+/);
    assert.ok(containers.length > 1);
    docker('stop', database);
    try {
      assert.equal((await (await request(tile, 503)).json()).code, 'ServiceUnavailable');
      assert.equal((await (await request('/mvt/observations', 503)).json()).code, 'ServiceUnavailable');
      docker('stop', ...containers);
      const { planId } = cli('config', 'plan', filename);
      cli('config', 'apply', planId);
      assert.equal(cli('status').currentVersion, planId);
      assert.deepEqual(await (await request(openapi)).json(), before);
      assert.deepEqual(Buffer.from(await (await request(file)).arrayBuffer()), archiveTile);
      assert.equal((await features('/mvt/other-observations/1/1/0', 'other-observations'))[0].properties.label,
        'Independent PostGIS');
      assert.equal((await (await request(tile, 503)).json()).code, 'ServiceUnavailable');
    } finally {
      docker('start', database);
      await waitForDatabase();
    }
    let status;
    for (let attempt = 0; attempt < 45; attempt++) {
      const response = await fetch(gateway + tile, { signal: AbortSignal.timeout(5000) });
      status = response.status;
      await response.body?.cancel();
      if (status === 200) break;
      await setTimeout(1000);
    }
    assert.equal(status, 200);
    assert.equal((await features(tile, 'observations'))[0].properties.id, 'row-1');
  });

  await t.test('a down Martin instance does not block an update to an independent provider', async () => {
    const container = martinContainer();
    assert.ok(container);
    docker('stop', database);
    docker('stop', container);
    await writeFile(filename, stringify({
      ...withArchive,
      publications: { ...withArchive.publications, control: { ...platform.publications.control, title: 'Updated control' } },
    }));
    const update = cli('config', 'plan', filename);
    cli('config', 'apply', update.planId);
    const control = '/features/collections/control?f=json';
    const response = await request(control).catch(async (error) => {
      // Docker Desktop can reset the first connection after replacing Caddy.
      if (error.cause?.code !== 'ECONNRESET') throw error;
      await setTimeout(100);
      return request(control);
    });
    const collection = await response.json();
    assert.equal(collection.title, 'Updated control');
    await request('/mvt/observations/1/1/0', 503);
    assert.deepEqual(Buffer.from(await (await request('/mvt/file-tile/0/0/0')).arrayBuffer()), archiveTile);
  });
});
