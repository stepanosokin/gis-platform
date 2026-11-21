import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { auth, register, signIn } from './access-client.mjs';
import { mapLibreBrowserOptions, renderMapLibre } from './maplibre-browser.mjs';
import { solidPng, writeMbtiles, writePmtiles } from './raster-tile-fixtures.mjs';

const filename = process.env.GIS_TEST_CONFIG;
const gateway = process.env.GIS_TEST_PUBLIC_URL;
const project = process.env.COMPOSE_PROJECT_NAME;
const martin = 'ghcr.io/maplibre/martin:1.16.1@sha256:59902019bf9038926ff0c71174237d6852e64c457830a6349abe7090be8818ca';
const fileProvider = {
  type: 'martin', image: martin,
  api: { protocol: 'mvt', scheme: 'http', port: 3000, base_path: '/native', public_root: '/mvt',
    links: 'canonical', readiness: '/health' },
};
const rasterPublication = { provider: 'archives', source: 'east', protocol: 'mvt', access: 'public',
  title: 'Raster web tiles', description: 'Known raster tiles', extent: [-180, -85, 180, 85] };
const platform = {
  schema_version: 1,
  server: { host: 'localhost', port: 8080 },
  sources: { east: { type: 'mbtiles', path: './fixture.mbtiles' }, west: { type: 'pmtiles', path: './fixture.pmtiles' } },
  providers: { archives: fileProvider },
  publications: { east: rasterPublication, west: { ...rasterPublication, source: 'west' } },
};

function cli(...args) {
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  return { status: result.status, response: JSON.parse(result.stdout) };
}

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

async function request(path, status = 200, options) {
  const response = await fetch(gateway + path, {
    ...options, headers: { Connection: 'close', ...options?.headers }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
  return response;
}

test('Martin accepts explicit raster archives and keeps PostGIS connections separate', async () => {
  async function validate(config) {
    await writeFile(filename, stringify(config));
    return cli('config', 'validate', filename);
  }
  const valid = await validate(platform);
  assert.equal(valid.status, 0, JSON.stringify(valid.response));
  const dbSource = { type: 'postgis', schema: 'gis', relation: 'places', id_field: 'id',
    geometry_field: 'geom', max_lag_seconds: 0 };
  const dbProvider = { ...fileProvider, postgis: { host: 'external-postgis', database: 'gis', user: 'reader',
    password_file: './password' } };
  const separated = { ...platform, sources: { ...platform.sources, db: dbSource },
    providers: { ...platform.providers, database: dbProvider },
    publications: { ...platform.publications, db: { ...rasterPublication, source: 'db', provider: 'database' } } };
  assert.equal((await validate(separated)).status, 0);
  for (const [config, expected] of [
    [{ ...platform, providers: { archives: dbProvider } }, /separate|file.*PostGIS/i],
    [{ ...separated, publications: { ...separated.publications, db: { ...rasterPublication, source: 'db' } } }, /PostGIS connection|separate/i],
    [{ ...platform, sources: { ...platform.sources, east: { type: 'mbtiles', path: './fixture.pmtiles' } } }, /\.mbtiles file/],
    [{ ...platform, publications: { east: { ...rasterPublication, mvt_properties: ['id'] } } }, /mvt_properties.*PostGIS/],
    [{ ...platform, providers: { archives: { type: 'pygeoapi' } },
      publications: { east: { ...rasterPublication, protocol: 'features' } } }, /unsupported by protocol 'features'/],
  ]) {
    const invalid = await validate(config);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.response.code, 'INVALID_CONFIG');
    assert.match(invalid.response.data.message, expected);
  }
});

test('Martin serves both raster archives through canonical, authorized gateway routes', async (t) => {
  const directory = dirname(filename);
  const red = solidPng([214, 57, 49]);
  const blue = solidPng([32, 108, 218]);
  writeMbtiles(join(directory, 'fixture.mbtiles'), red);
  await writePmtiles(join(directory, 'fixture.pmtiles'), blue);
  await writePmtiles(join(directory, 'unlisted.pmtiles'), blue);

  const browser = createServer();
  await new Promise((resolve, reject) => {
    browser.once('error', reject);
    browser.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${browser.address().port}`;
  await new Promise((resolve) => browser.close(resolve));
  const authConfig = { mode: 'development', mailpit_port: Number(new URL(process.env.GIS_TEST_MAILPIT).port) };
  for (const name of ['secret_file', 'postgres_password_file']) {
    authConfig[name] = join(directory, `raster-${name}`);
    await writeFile(authConfig[name], randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  const config = { ...platform, server: { host: 'localhost', port: Number(new URL(gateway).port) },
    auth: authConfig, cors: { allowed_origins: [origin] },
    publications: { red: rasterPublication, blue: { ...rasterPublication, source: 'west', access: 'registered' },
      private: { ...rasterPublication, source: 'west', access: 'private' } } };
  await writeFile(filename, stringify(config));
  try {
    const plan = cli('config', 'plan', filename);
    assert.equal(plan.status, 0, JSON.stringify(plan.response));
    assert.equal(plan.response.data.newUrl, gateway + '/mvt/red');
    const applied = cli('config', 'apply', plan.response.data.planId);
    assert.equal(applied.status, 0, JSON.stringify(applied.response));

    const container = docker('ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=provider-archives');
    assert.ok(container);
    const [provider] = JSON.parse(docker('inspect', container));
    assert.deepEqual(provider.HostConfig.PortBindings ?? {}, {});
    const mounts = provider.Mounts.filter(({ Destination }) => Destination.startsWith('/source/'));
    assert.equal(mounts.length, 2);
    assert.deepEqual(mounts.map(({ Destination, RW }) => [Destination.split('.').at(-1), RW]).sort(),
      [['mbtiles', false], ['pmtiles', false]]);
    assert.equal(provider.Mounts.some(({ Destination }) => Destination.startsWith('/run/secrets/')), false);
    const { tiles } = JSON.parse(docker('exec', container, 'wget', '-qO-', 'http://127.0.0.1:3000/native/catalog'));
    assert.deepEqual(Object.keys(tiles).sort(), ['blue', 'private', 'red']);

    const email = 'raster-reader@example.test';
    const password = randomBytes(24).toString('hex');
    await register(email, password);
    const cookie = await signIn(email, password);
    const token = await auth('tokens/create', { name: 'Raster web tiles' }, cookie);
    assert.equal(token.status, 201);
    const { id: tokenId, secret } = await token.json();
    const bearer = { Origin: origin, Authorization: `Bearer ${secret}` };
    for (const [id, png, headers] of [['red', red, { Origin: origin }], ['blue', blue, bearer]]) {
      const path = `/mvt/${id}`;
      const response = await request(path + '?ignored=1', 200, { headers: { ...headers,
        'X-Rewrite-URL': 'http://example.invalid/', Forwarded: 'host=example.invalid;proto=https' } });
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      const tilejson = await response.json();
      assert.deepEqual(tilejson.tiles, [gateway + path + '/{z}/{x}/{y}']);
      assert.equal(tilejson.scheme ?? 'xyz', 'xyz');
      assert.equal(tilejson.minzoom, 0);
      assert.equal(tilejson.maxzoom, 0);
      assert.equal(tilejson.vector_layers, undefined);
      const tile = await request(path + '/0/0/0', 200, { headers });
      assert.match(tile.headers.get('content-type'), /^image\/png\b/);
      assert.deepEqual(Buffer.from(await tile.arrayBuffer()), png);
      await request(path + '/0/0/0', 200, { method: 'HEAD', headers });
    }
    for (const suffix of ['', '/0/0/0']) {
      await request('/mvt/blue' + suffix, 401);
      await request('/mvt/private' + suffix, 403, { headers: bearer });
      const cors = await request('/mvt/blue' + suffix, 204, { method: 'OPTIONS', headers: {
        Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
      } });
      assert.equal(cors.headers.get('access-control-allow-origin'), origin);
      assert.match(cors.headers.get('access-control-allow-headers'), /authorization/i);
    }
    for (const path of ['/mvt', '/mvt/catalog', '/mvt/health', '/mvt/unlisted', '/mvt/fixture', '/mvt/red,blue/0/0/0',
      '/mvt/red/0/0/0.png', '/mvt/red/0/0/0/extra', '/native/red']) await request(path, 404);

    await t.test('MapLibre GL JS renders the control image from each archive', mapLibreBrowserOptions, async () => {
      const sources = [{ url: gateway + '/mvt/red' }, { url: gateway + '/mvt/blue', secret }];
      const script = `
        for (const { url: source, secret } of ${JSON.stringify(sources)}) {
          const map = new Map({
            container: 'map', center: [0, 0], zoom: 0, attributionControl: false,
            canvasContextAttributes: { preserveDrawingBuffer: true },
            transformRequest: (url) => secret && (url === source || url.startsWith(source + '/'))
              ? { url, headers: { Authorization: 'Bearer ' + secret } } : { url },
            style: {
              version: 8,
              sources: { archive: { type: 'raster', url: source, tileSize: 256 } },
              layers: [{ id: 'image', type: 'raster', source: 'archive', paint: { 'raster-fade-duration': 0 } }],
            },
          });
          try {
            await new Promise((resolve, reject) => {
              map.once('error', ({ error }) => reject(error));
              map.once('idle', resolve);
            });
            const canvas = map.getCanvas();
            const gl = canvas.getContext('webgl2');
            const pixel = new Uint8Array(4);
            gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            await report({ source, pixel: [...pixel] });
          } finally {
            map.remove();
          }
        }`;
      const frames = await renderMapLibre({ origin, results: directory, name: 'raster-tiles-browser', script, frameCount: 2 });
      assert.deepEqual(frames.map(({ source, pixel }) => [source, pixel]), [
        [sources[0].url, [214, 57, 49, 255]],
        [sources[1].url, [32, 108, 218, 255]],
      ]);
    });

    await t.test('a vector archive cannot replace an active raster archive', async () => {
      const candidate = { ...config, sources: { ...config.sources,
        west: { ...config.sources.west, path: './vector.pmtiles' } } };
      const vector = Buffer.from([0x1a, 5, 0x0a, 1, 0x78, 0x78, 2]);
      await writePmtiles(join(directory, 'vector.pmtiles'), vector, 1);
      await writeFile(filename, stringify(candidate));
      const invalidPlan = cli('config', 'plan', filename);
      assert.equal(invalidPlan.status, 0, JSON.stringify(invalidPlan.response));
      assert.ok(invalidPlan.response.data.services.includes('provider-archives'));
      const rejected = cli('config', 'apply', invalidPlan.response.data.planId);
      assert.equal(rejected.status, 6, JSON.stringify(rejected.response));
      assert.equal(rejected.response.code, 'APPLY_FAILED');
      assert.equal(rejected.response.data.currentVersion, plan.response.data.planId);
      assert.match(rejected.response.data.message, /failed to open its tile archives/);
      const metadata = await request('/mvt/red');
      assert.deepEqual((await metadata.json()).tiles, [gateway + '/mvt/red/{z}/{x}/{y}']);
      assert.deepEqual(Buffer.from(await (await request('/mvt/red/0/0/0')).arrayBuffer()), red);
      assert.deepEqual(Buffer.from(await (await request('/mvt/blue/0/0/0', 200, { headers: bearer })).arrayBuffer()), blue);
    });

    await t.test('replacing archive content keeps its URL and can roll back to a preserved file', async () => {
      const replaced = 'replacement.mbtiles';
      const green = solidPng([38, 152, 86]);
      writeMbtiles(join(directory, replaced), green);
      const candidate = { ...config, sources: { ...config.sources,
        east: { ...config.sources.east, path: `./${replaced}` } } };
      await writeFile(filename, stringify(candidate));
      const applyReplacement = async (png) => {
        const replacement = cli('config', 'plan', filename);
        assert.equal(replacement.status, 0, JSON.stringify(replacement.response));
        assert.ok(replacement.response.data.services.includes('provider-archives'));
        assert.equal(replacement.response.data.newUrl, gateway + '/mvt/red');
        const applied = cli('config', 'apply', replacement.response.data.planId);
        assert.equal(applied.status, 0, JSON.stringify(applied.response));
        assert.deepEqual(Buffer.from(await (await request('/mvt/red/0/0/0')).arrayBuffer()), png);
      };
      await applyReplacement(green);
      writeMbtiles(join(directory, 'second-replacement.mbtiles'), blue);
      await copyFile(join(directory, 'second-replacement.mbtiles'), join(directory, replaced));
      await applyReplacement(blue);

      const rollback = cli('config', 'plan', '--rollback-to', plan.response.data.planId);
      assert.equal(rollback.status, 0, JSON.stringify(rollback.response));
      const restored = cli('config', 'apply', rollback.response.data.planId);
      assert.equal(restored.status, 0, JSON.stringify(restored.response));
      assert.deepEqual(Buffer.from(await (await request('/mvt/red/0/0/0')).arrayBuffer()), red);
    });
    assert.equal((await auth('tokens/revoke', { id: tokenId }, cookie)).status, 204);
    await request('/mvt/blue', 401, { headers: bearer });
    await request('/mvt/blue/0/0/0', 401, { headers: bearer });
  } finally {
    docker('compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f', 'compose.mailpit.yaml',
      'down', '--remove-orphans', '--volumes');
  }
});
