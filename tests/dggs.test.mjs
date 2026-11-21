import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { get as httpsGet } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { auth, register, request, signIn } from './access-client.mjs';

const gateway = process.env.GIS_TEST_PUBLIC_URL;
const filename = process.env.GIS_TEST_CONFIG;
const project = process.env.COMPOSE_PROJECT_NAME;
const image = 'ghcr.io/landscapegeoinformatics/pydggsapi@sha256:2c2b1683a474243639d59849679e32a434ab5581a7e54ce02879213bf509ea63';

function command(binary, args) {
  const { error, stdout, stderr, status } = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true });
  assert.ifError(error);
  assert.equal(status, 0, stdout + stderr);
  return stdout;
}

function docker(...args) {
  return command('docker', args);
}

function cli(...args) {
  const result = JSON.parse(command(process.execPath, ['dist/cli.js', ...args, '--json']));
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return result;
}

function rejectCli(status, reason, ...args) {
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args, '--json'],
    { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stdout);
  assert.match(JSON.parse(result.stdout).data.message, reason);
}

async function get(path, status = 200, headers) {
  const url = new URL(path, gateway);
  assert.equal(url.origin, gateway, url.href);
  const response = await request(url, { headers: { Connection: 'close', ...headers }, redirect: 'manual' });
  assert.equal(response.status, status, url.href);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
}

function polygon(wkb) {
  const bytes = Buffer.from(wkb, 'hex');
  assert.equal(bytes.readUInt8(0), 1);
  assert.equal(bytes.readUInt32LE(1), 3);
  assert.equal(bytes.readUInt32LE(5), 1);
  return { type: 'Polygon', coordinates: [Array.from({ length: bytes.readUInt32LE(9) }, (_, index) =>
    [bytes.readDoubleLE(13 + index * 16), bytes.readDoubleLE(21 + index * 16)])] };
}

const collectionPath = (id) => `/dggs/collections/${id}`;
const zonesPath = (id) => `${collectionPath(id)}/dggs/h3/zones`;
const bboxQuery = (bbox, limit) => new URLSearchParams({
  bbox, 'zone-level': '7', 'compact-zones': 'false', f: 'geojson', geometry: 'zone-region',
  ...(limit && { limit }),
});

test('pydggsapi serves H3 snapshots through the configured gateway', async (t) => {
  const directory = dirname(filename);
  t.after(() => docker('compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.auth.yaml',
    '-f', 'compose.mailpit.yaml', 'down', '--remove-orphans', '--volumes'));
  const platform = {
    schema_version: 1,
    server: { host: 'localhost', port: Number(new URL(gateway).port),
      tls: { cert_file: 'https-cert.pem', key_file: 'https-key.pem', ca_file: 'https-cert.pem' } },
    sources: Object.fromEntries(['dense', 'sparse'].map((name) => [name, {
      type: 'parquet', path: `${name}-v1.parquet`, id_field: 'h3_id', resolution: 7, properties: ['tally', 'metric'],
    }])),
    providers: { grids: {
      type: 'pydggsapi', image,
      api: { protocol: 'dggs', scheme: 'http', port: 8000, base_path: '/dggs', public_root: '/dggs',
        links: 'canonical', readiness: '/conformance' },
    } },
    cors: { allowed_origins: ['https://client.example.test'] },
    publications: Object.fromEntries([
      ['dense', 'dense', 'public'],
      ['sparse', 'sparse', 'public'],
      ['registered-grid', 'sparse', 'registered'],
      ['private-grid', 'sparse', 'private'],
    ].map(([id, source, access]) => [id, {
      source, access, provider: 'grids', protocol: 'dggs', title: `Grid ${id}`,
      description: `H3 resolution 7 for ${id}`, extent: [11.8, 45, 12.9, 45.9],
    }])),
    auth: {
      mode: 'development', secret_file: 'dggs-secret', postgres_password_file: 'dggs-postgres',
      administrator_emails: ['grids-admin@example.test'], mailpit_port: Number(new URL(process.env.GIS_TEST_MAILPIT).port),
      cli: { port: Number(process.env.GIS_ADMIN_PORT), ca_file: 'ca.pem', cert_file: 'server.pem',
        key_file: 'server-key.pem', operators: { operator: ['access-write', 'diagnostics'] } },
    },
  };
  for (const field of ['secret_file', 'postgres_password_file']) {
    await writeFile(join(directory, platform.auth[field]), randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  docker('run', '--rm', '--platform', 'linux/amd64', '--mount', `type=bind,src=${directory},dst=/fixture`,
    '--mount', `type=bind,src=${resolve('tests/pydggsapi-acceptance.py')},dst=/probe.py,readonly`,
    image, 'python', '/probe.py', 'fixtures', '--safe-integers');
  const plan = async () => {
    await writeFile(filename, stringify(platform));
    cli('config', 'validate', filename);
    return cli('config', 'plan', filename).data;
  };
  const original = await plan();
  cli('config', 'apply', original.planId);
  const fixture = JSON.parse(await readFile(join(directory, 'oracle.json'), 'utf8'));
  const base = zonesPath('sparse');
  const dataUrl = new URL(`${base}/${fixture.zero}/data?zone-depth=0`, gateway);
  // Compose may recreate Caddy. Use an independent TLS connection for the first read after apply.
  const readSnapshot = () => new Promise((done, fail) => {
    const outgoing = httpsGet(dataUrl, { agent: false, signal: AbortSignal.timeout(10_000) }, async (response) => {
      try {
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['cache-control'], 'no-store');
        done(JSON.parse(await text(response)));
      } catch (error) {
        fail(error);
      }
    });
    outgoing.on('error', fail);
  });

  await t.test('zone geometries and depth-0 data preserve exact values in the supported range', async () => {
    const zone = await (await get(`${base}/${fixture.zero}`)).json();
    assert.equal(zone.id, fixture.zero);
    assert.equal(zone.level, 7);
    assert.deepEqual(zone.geometry, polygon(fixture.cells.sparse[fixture.zero]));
    const dataLink = zone.links.find(({ rel }) => rel === '[ogc-rel:dggrs-zone-data]');
    assert.equal(dataLink.href, gateway + `${base}/${fixture.zero}/data`);
    const bareData = await (await get(dataLink.href)).json();
    assert.deepEqual(bareData.depths, [0]);
    for (const [kind, tally, metric] of [['zero', 0, 0], ['null', null, null], ['positive', Number.MAX_SAFE_INTEGER, 4.25]]) {
      const data = await (await get(`${base}/${fixture[kind]}/data?zone-depth=0`)).json();
      assert.equal(data.zoneId, fixture[kind]);
      assert.deepEqual(data.depths, [0]);
      assert.deepEqual(data.values['sparse.tally'][0].data, [tally]);
      assert.deepEqual(data.values['sparse.metric'][0].data, [metric]);
      if (kind === 'null') assert.equal((await (await get(`${base}/${fixture.null}`)).json()).id, fixture.null);
    }
    assert.equal(await (await get(`${base}/${fixture.missing}/data?zone-depth=0`, 204)).text(), '');
    assert.equal(await (await get(`${base}/${fixture.missing}`, 204)).text(), '');
  });

  await t.test('complete bbox windows give all matching dense and sparse H3 polygons', async () => {
    const small = '12.28,45.41,12.36,45.47';
    const large = '11.8,45,12.9,45.9';
    for (const [collection, defaultCount] of [['dense', 1000], ['sparse', 36]]) {
      const ids = Object.keys(fixture.cells[collection]);
      for (const [bbox, limit, expected] of [[small, undefined, fixture.small[collection]], [large, 10000, ids]]) {
        const response = await get(`${zonesPath(collection)}?${bboxQuery(bbox, limit)}`);
        const result = await response.json();
        assert.equal(result.type, 'FeatureCollection');
        assert.deepEqual(result.features.map(({ properties }) => properties.zoneId).sort(), expected.toSorted());
        for (const { geometry, properties: { zoneId } } of result.features) {
          assert.deepEqual(geometry, polygon(fixture.cells[collection][zoneId]));
        }
      }
      const limited = await (await get(`${zonesPath(collection)}?${bboxQuery(large)}`)).json();
      assert.equal(limited.features.length, defaultCount);
    }
    await get(`${base}/${fixture.zero}/data?zone-depth=1`, 400);
    await get(`${base}/${fixture.zero}/data?zone-depth=0&properties=tally`, 400);
    const params = bboxQuery(small);
    params.delete('compact-zones');
    await get(`${base}?${params}`, 400);
    params.append('compact-zones', 'false');
    params.append('compact-zones', 'false');
    await get(`${base}?${params}`, 400);
    params.delete('compact-zones');
    params.append('compact-zones', 'false');
    params.set('bbox', '12.28,0,NaN,45.47');
    await get(`${base}?${params}`, 400);
  });

  await t.test('canonical catalogs, Swagger, OpenAPI and collection routes obey access grants', async () => {
    const landing = await (await get('/dggs')).json();
    const apiLink = landing.links.find(({ rel }) => rel === 'service-desc').href;
    const docLink = landing.links.find(({ rel }) => rel === 'service-doc').href;
    assert.equal(apiLink, gateway + '/dggs/openapi');
    assert.equal(docLink, gateway + '/dggs/docs');
    assert.match(await (await get(docLink)).text(), /url: ['"]\/dggs\/openapi['"]/);
    const expectVisible = async (expected, headers) => {
      const catalog = await (await get('/dggs/collections?f=json', 200, headers)).json();
      assert.deepEqual(catalog.collections.map(({ id }) => id).sort(), expected.toSorted());
      const response = await get(apiLink, 200, headers);
      assert.match(response.headers.get('content-type'), /version=3\.1/);
      const api = await response.json();
      assert.deepEqual(api.servers, [{ url: gateway + '/dggs' }]);
      const ids = [...new Set(Object.keys(api.paths).map((path) => /^\/collections\/([^/]+)/.exec(path)?.[1]))];
      assert.deepEqual(ids.sort(), expected.toSorted());
      for (const id of expected) {
        const base = `/collections/${id}/dggs/h3/zones`;
        for (const suffix of ['', '/{zoneId}', '/{zoneId}/data']) {
          assert.ok(api.paths[base + suffix]?.get);
          if (id.endsWith('-grid')) assert.deepEqual(api.paths[base + suffix].get.security, [{ session: [] }, { bearer: [] }]);
        }
        const params = Object.fromEntries(api.paths[base].get.parameters.map(({ name, ...parameter }) => [name, parameter]));
        assert.equal(params.bbox.required, true);
        assert.equal(params['zone-level'].required, true);
        assert.equal(params['compact-zones'].required, true);
        assert.deepEqual(params['compact-zones'].schema.enum, [false]);
        assert.deepEqual(params.geometry.schema.enum, ['zone-region']);
        assert.deepEqual(params.f.schema.enum, ['geojson']);
        const depth = api.paths[base + '/{zoneId}/data'].get.parameters.find(({ name }) => name === 'zone-depth');
        assert.deepEqual(depth.schema.enum, [0]);
      }
    };
    const expectAccess = async (id, status, headers) => {
      const collection = collectionPath(id);
      const zone = `${zonesPath(id)}/${fixture.zero}`;
      for (const path of [collection, `${collection}/dggs/h3`, zone, `${zone}/data?zone-depth=0`,
        `${zonesPath(id)}?${bboxQuery('12.28,45.41,12.36,45.47')}`]) {
        await (await get(path, status, headers)).arrayBuffer();
      }
    };
    await expectVisible(['dense', 'sparse']);
    await expectAccess('sparse', 200);
    await expectAccess('registered-grid', 401);
    await expectAccess('private-grid', 401);
    const email = 'dggs-reader@example.test';
    const password = randomBytes(24).toString('hex');
    await register(email, password);
    const cookie = await signIn(email, password);
    const session = { Cookie: cookie };
    await expectVisible(['dense', 'sparse', 'registered-grid'], session);
    await expectAccess('registered-grid', 200, session);
    await expectAccess('private-grid', 403, session);

    cli('access', 'grant', 'private-grid', '--email', email);
    const token = await auth('tokens/create', { name: 'H3 client' }, cookie);
    assert.equal(token.status, 201);
    const bearer = { Authorization: `Bearer ${(await token.json()).secret}` };
    await expectVisible(['dense', 'sparse', 'registered-grid', 'private-grid'], bearer);
    await expectAccess('private-grid', 200, bearer);
    const origin = platform.cors.allowed_origins[0];
    const crossOriginPath = `${zonesPath('private-grid')}/${fixture.zero}/data?zone-depth=0`;
    const preflight = await request(crossOriginPath, { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(await preflight.text(), '');
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const crossOrigin = await get(crossOriginPath, 200, { ...bearer, Origin: origin });
    assert.equal(crossOrigin.headers.get('access-control-allow-origin'), origin);
    await crossOrigin.arrayBuffer();

    const expectedCollection = gateway + collectionPath('private-grid');
    const collection = await (await get(expectedCollection + '?f=json', 200, bearer)).json();
    assert.equal(collection.id, 'private-grid');
    assert.equal(collection.title, platform.publications['private-grid'].title);
    assert.equal(collection.description, platform.publications['private-grid'].description);
    assert.deepEqual(collection.extent.spatial.bbox[0], platform.publications['private-grid'].extent);
    for (const { href } of collection.links) {
      assert.ok(href.startsWith(expectedCollection));
      await (await get(href, 200, bearer)).arrayBuffer();
      await (await get(href, 401)).arrayBuffer();
    }
    const grids = await (await get(expectedCollection + '/dggs', 200, bearer)).json();
    const h3 = grids.dggrs[0].links.find(({ rel }) => rel === 'self').href;
    const grid = await (await get(h3, 200, bearer)).json();
    assert.equal(grid.id, 'h3');
    assert.equal(grid.maxRefinementLevel, 7);
    for (const { uriTemplate } of grid.linkTemplates) {
      await (await get(uriTemplate.replace('{zoneId}', fixture.zero), 200, bearer)).arrayBuffer();
    }
    await get(`/dggs/dggs/h3/zones/${fixture.zero}/data?zone-depth=0`, 404, bearer);
    await get(`/dggs/dggs/h3/zones?${bboxQuery('12.28,45.41,12.36,45.47')}`, 404);
    for (const path of ['/openapi.json', '/dggs/openapi.json', '/dggs/dggs', '/tiles-api', '/collections/private-grid']) {
      await get(path, 404);
    }
    const container = docker('ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=provider-grids').trim();
    assert.ok(container);
    assert.equal(docker('port', container).trim(), '');
    const mounts = JSON.parse(docker('inspect', '--format', '{{json .Mounts}}', container));
    const snapshots = mounts.filter(({ Destination }) => Destination.startsWith('/source/'));
    assert.equal(snapshots.length, 2);
    assert.ok(snapshots.every(({ RW }) => RW === false));
    cli('access', 'revoke', 'private-grid', '--email', email);
    await expectAccess('private-grid', 403, bearer);
  });

  await t.test('CLI validates snapshots and switches and restores versions at the same URL', async () => {
    const rejectCandidate = async (reason) => rejectCli(6, reason, 'config', 'apply', (await plan()).planId);
    platform.sources.sparse.path = 'sparse-duplicate.parquet';
    await rejectCandidate(/Invalid DGGS snapshot 'sparse'/);
    platform.sources.sparse.path = 'sparse-int32.parquet';
    await rejectCandidate(/BIGINT or DOUBLE indicators/);
    platform.sources.sparse.path = 'sparse-reserved-column.parquet';
    platform.sources.sparse.properties = ['select', 'metric'];
    await rejectCandidate(/Invalid DGGS snapshot 'sparse'/);
    platform.sources.sparse.properties = ['tally', 'metric'];
    const changed = join(directory, 'sparse-changed.parquet');
    await copyFile(join(directory, 'sparse-v2.parquet'), changed);
    platform.sources.sparse.path = 'sparse-changed.parquet';
    const stale = await plan();
    await copyFile(join(directory, 'sparse-v1.parquet'), changed);
    rejectCli(6, /DGGS snapshot source 'sparse' changed after planning/, 'config', 'apply', stale.planId);
    assert.deepEqual((await readSnapshot()).values['sparse.tally'][0].data, [0]);

    platform.sources.sparse.path = 'sparse-v2.parquet';
    const next = await plan();
    cli('config', 'apply', next.planId);
    const current = await readSnapshot();
    assert.deepEqual(current.values['sparse.tally'][0].data, [9]);
    assert.deepEqual(current.values['sparse.metric'][0].data, [3.5]);
    const prior = join(directory, 'sparse-v1.parquet');
    // The stale-plan case left a byte-for-byte backup of the prior snapshot.
    try {
      await copyFile(join(directory, 'sparse-v2.parquet'), prior);
      rejectCli(2, /archived DGGS snapshot no longer matches/, 'config', 'plan', '--rollback-to', original.planId);
    } finally {
      await copyFile(changed, prior);
    }
    const rollback = cli('config', 'plan', '--rollback-to', original.planId);
    cli('config', 'apply', rollback.data.planId);
    assert.deepEqual((await readSnapshot()).values['sparse.tally'][0].data, [0]);
  });
});
