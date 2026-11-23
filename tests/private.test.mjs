import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { dirname, join } from 'node:path';
import { json } from 'node:stream/consumers';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { auth, cookieFrom, emailLink, register, request, session, signIn } from './access-client.mjs';

const gateway = process.env.GIS_TEST_PUBLIC_URL;
const privateCollection = '/pygeoapi/features/collections/private-places';
const items = `${privateCollection}/items/central?f=json`;
const publicItems = '/pygeoapi/features/collections/places/items/central?f=json';
const password = 'private-password-16';

test('a signed-in user can create a named token and read a private publication with Bearer', async () => {
  const email = 'token-owner@example.test';
  await register(email, password);
  const cookie = await signIn(email, password);
  cli(['access', 'grant', 'private-places', '--email', email]);
  const created = await auth('tokens/create', { name: 'QGIS' }, cookie);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { id, name, secret } = await created.json();
  assert.ok(id && typeof secret === 'string' && secret.length > 32);
  assert.equal(name, 'QGIS');
  const list = await request('/api/auth/tokens', { headers: { Cookie: cookie } });
  const listing = await list.text();
  assert.equal(listing.includes(secret), false);
  assert.deepEqual(JSON.parse(listing).tokens.map(({ id, name }) => ({ id, name })), [{ id, name }]);
  const feature = await request(items, { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(feature.status, 200);
  assert.equal((await feature.json()).id, 'central');
});

function cli(args, expected = 'OK', exitCode = 0, environment = {}) {
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args, '--json'], {
    env: { ...process.env, ...environment }, encoding: 'utf8',
    timeout: ['config', 'provider'].includes(args[0]) ? 180_000 : 15_000, windowsHide: true,
  });
  assert.ifError(result.error);
  const response = JSON.parse(result.stdout);
  assert.equal(response.code, expected, result.stdout);
  assert.equal(response.status, exitCode === 0 ? 'ok' : 'error');
  assert.equal(result.status, exitCode, result.stderr);
  return response.data;
}

function dockerJson(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function compose(...args) {
  const revision = process.env.GIS_REVISION_DIR;
  return dockerJson('compose', '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f', 'compose.mailpit.yaml',
    '-f', join(revision, 'compose.admin.json'), ...args);
}

function operator(name) {
  return {
    GIS_ADMIN_CERT_FILE: join(process.env.GIS_TEST_RESULTS, `${name}.pem`),
    GIS_ADMIN_KEY_FILE: join(process.env.GIS_TEST_RESULTS, `${name}-key.pem`),
  };
}

function publications(user) {
  return user.publications.map(({ id }) => id);
}

const bearer = (secret) => ({ headers: { Authorization: `Bearer ${secret}` } });
const day = 24 * 60 * 60 * 1000;

async function createToken(cookie, name) {
  const response = await auth('tokens/create', { name }, cookie);
  assert.equal(response.status, 201);
  return response.json();
}

async function tokens(cookie) {
  const response = await request('/api/auth/tokens', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return (await response.json()).tokens;
}

test('Bearer expiry moves on admission and current grants govern data and metadata', async () => {
  const email = 'token-sliding@example.test';
  await register(email, password);
  const cookie = await signIn(email, password);
  const { id, secret, createdAt, expiresAt } = await createToken(cookie, 'Expiry');
  assert.ok(Math.abs(Date.parse(expiresAt) - Date.parse(createdAt) - 90 * day) < 1000);
  await setTimeout(20);
  assert.equal((await request(items, bearer(secret))).status, 403);
  assert.equal((await tokens(cookie)).find((token) => token.id === id).expiresAt, expiresAt);
  cli(['access', 'grant', 'private-places', '--email', email]);
  const admitted = await request(items, bearer(secret));
  assert.equal(admitted.status, 200);
  const extended = (await tokens(cookie)).find((token) => token.id === id).expiresAt;
  assert.ok(Date.parse(extended) > Date.parse(expiresAt));
  assert.ok(Math.abs(Date.parse(extended) - Date.now() - 90 * day) < 5000);
  const catalog = await request('/pygeoapi/features/collections?f=json', bearer(secret));
  assert.deepEqual((await catalog.json()).collections.map(({ id }) => id),
    ['registered-places', 'places', 'private-places']);
  const api = await request('/pygeoapi/features/openapi?f=json', bearer(secret));
  const openapi = await api.json();
  assert.deepEqual(openapi.paths['/collections/private-places/items'].get.security, [{ session: [] }, { bearer: [] }]);
  assert.deepEqual(openapi.components.securitySchemes.bearer, { type: 'http', scheme: 'bearer' });
  assert.equal(openapi.paths['/collections/other-private/items'], undefined);
  // The linked catalog is filtered by the same rights as collection data.
  const linkedCatalog = await request('/pygeoapi/features/collections?f=jsonld', bearer(secret));
  assert.equal(linkedCatalog.status, 200);
  assert.deepEqual((await linkedCatalog.json()).dataset.map((entry) => new URL(entry['@id']).pathname),
    ['/pygeoapi/features/collections/registered-places', '/pygeoapi/features/collections/places', privateCollection]);
  cli(['access', 'revoke', 'private-places', '--email', email]);
  assert.equal((await request(items, bearer(secret))).status, 403);
  assert.equal((await request('/pygeoapi/features/collections/registered-places/items?f=json', bearer(secret))).status, 200);
  const beforePublic = (await tokens(cookie))[0].expiresAt;
  await setTimeout(20);
  assert.equal((await request(publicItems, bearer(secret))).status, 200);
  const afterPublic = (await tokens(cookie))[0].expiresAt;
  assert.ok(Date.parse(afterPublic) > Date.parse(beforePublic));
  assert.equal((await request(publicItems)).status, 200);
  assert.equal((await request(publicItems, bearer('invalid'))).status, 200);
  assert.equal((await tokens(cookie))[0].expiresAt, afterPublic);

  // Place the existing key in the past without changing the host clock or the 90-day policy.
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  compose('exec', '-T', 'postgres', 'psql', '-U', 'gis', '-d', 'gis', '-c',
    `UPDATE apikey SET "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = '${id}';`);
  const expired = (await tokens(cookie))[0].expiresAt;
  assert.equal((await request(publicItems, bearer(secret))).status, 200);
  assert.equal((await request(items, bearer(secret))).status, 401);
  assert.equal((await tokens(cookie))[0].expiresAt, expired);
});

test('own and operator revocation affect one token and cannot be undone by concurrent use', async () => {
  const email = 'token-revocation@example.test';
  const outsider = 'token-outsider@example.test';
  for (const account of [email, outsider]) await register(account, password);
  const cookie = await signIn(email, password);
  const otherCookie = await signIn(outsider, password);
  const { userId } = cli(['access', 'grant', 'private-places', '--email', email]);
  const page = await request('/account/tokens', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Personal tokens/);
  const first = await createToken(cookie, 'First');
  const second = await createToken(cookie, 'Second');
  const api = await request('/api/auth/tokens', bearer(first.secret));
  assert.equal(api.status, 401);
  assert.equal(await (await request('/api/auth/get-session', bearer(first.secret))).json(), null);
  const foreign = await request('/api/auth/tokens/create', {
    method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cross-origin' }),
  });
  assert.equal(foreign.status, 403);
  for (const [body, status] of [['{', 400], [JSON.stringify({ name: 'x'.repeat(4096) }), 413]]) {
    const invalid = await request('/api/auth/tokens/create', {
      method: 'POST', headers: { Cookie: cookie, Origin: gateway, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(invalid.status, status);
  }
  assert.equal((await auth('tokens/revoke', { id: first.id }, otherCookie)).status, 404);
  const listing = cli(['tokens', 'list', '--user-id', userId], 'OK', 0, operator('reader')).tokens;
  assert.deepEqual(new Set(listing.map(({ id }) => id)), new Set([first.id, second.id]));
  assert.equal(JSON.stringify(listing).includes(first.secret), false);
  cli(['tokens', 'revoke', second.id, '--email', email], 'FORBIDDEN', 4, operator('reader'));
  cli(['tokens', 'revoke', second.id, '--email', outsider], 'NOT_FOUND', 3, operator('writer'));
  const competing = [request(items, bearer(first.secret)), auth('tokens/revoke', { id: first.id }, cookie)];
  const [read, revoked] = await Promise.all(competing);
  assert.ok([200, 401].includes(read.status));
  assert.equal(revoked.status, 204);
  assert.equal((await request(items, bearer(first.secret))).status, 401);
  assert.equal((await request(publicItems, bearer(first.secret))).status, 200);
  assert.equal((await request(items, bearer(second.secret))).status, 200);
  const beforeBlock = (await tokens(cookie)).find(({ id }) => id === second.id).expiresAt;
  const pending = request(items, bearer(second.secret));
  cli(['users', 'block', '--user-id', userId]);
  assert.ok([200, 403].includes((await pending).status));
  assert.equal((await request(items, bearer(second.secret))).status, 403);
  const blocked = () => cli(['tokens', 'list', '--email', email]).tokens.find(({ id }) => id === second.id).expiresAt;
  const expiryWhileBlocked = blocked();
  assert.ok(Date.parse(expiryWhileBlocked) >= Date.parse(beforeBlock));
  assert.equal((await request(publicItems, bearer(second.secret))).status, 200);
  assert.equal(blocked(), expiryWhileBlocked);
  cli(['users', 'unblock', '--user-id', userId]);
  const concurrent = request(items, bearer(second.secret));
  cli(['tokens', 'revoke', second.id, '--user-id', userId], 'OK', 0, operator('writer'));
  assert.ok([200, 401].includes((await concurrent).status));
  assert.equal((await request(items, bearer(second.secret))).status, 401);
  cli(['tokens', 'revoke', second.id, '--email', email], 'NO_CHANGE');
});

test('password change and recovery invalidate all tokens and older web sessions', async () => {
  const email = 'token-recovery@example.test';
  const changed = 'next-password-17';
  const recovered = 'recovered-password-17';
  const registered = '/pygeoapi/features/collections/registered-places/items?f=json';
  await register(email, password);
  const current = await signIn(email, password);
  const other = await signIn(email, password);
  const beforeChange = await Promise.all([createToken(current, 'One'), createToken(other, 'Two')]);
  assert.equal((await auth('change-password', { currentPassword: 'wrong-password', newPassword: changed }, current)).status, 400);
  for (const { secret } of beforeChange) assert.equal((await request(registered, bearer(secret))).status, 200);
  const update = await auth('change-password', { currentPassword: password, newPassword: changed }, current);
  assert.equal(update.status, 200);
  const kept = cookieFrom(update);
  for (const { secret } of beforeChange) assert.equal((await request(registered, bearer(secret))).status, 401);
  assert.equal(await session(other), null);
  assert.equal(await session(current), null);
  assert.ok((await session(kept)).user);

  const beforeRecovery = await createToken(kept, 'After password change');
  const otherAfterChange = await signIn(email, changed);
  assert.equal((await auth('request-password-reset', { email })).status, 200);
  const link = await emailLink(email, '/account/reset-password');
  const reset = await auth('reset-password', { token: new URL(link).searchParams.get('token'), newPassword: recovered });
  assert.equal(reset.status, 200);
  assert.equal((await request(registered, bearer(beforeRecovery.secret))).status, 401);
  assert.equal(await session(kept), null);
  assert.equal(await session(otherAfterChange), null);
  const fresh = await createToken(await signIn(email, recovered), 'After recovery');
  assert.equal((await request(registered, bearer(fresh.secret))).status, 200);
});

test('publication request records correlate stable IDs without logging credentials or invalid identities', async () => {
  const email = 'token-audit@example.test';
  await register(email, password);
  const cookie = await signIn(email, password);
  const { userId } = cli(['access', 'grant', 'private-places', '--email', email]);
  const { id, secret } = await createToken(cookie, 'Audited');
  const claims = 'caller-supplied-id';
  const admitted = await request(items, { headers: { Authorization: `Bearer ${secret}`, 'X-GIS-Request-Id': claims } });
  assert.equal(admitted.status, 200);
  const rejected = await request('/pygeoapi/features/collections/other-private?f=json', bearer(secret));
  assert.equal(rejected.status, 403);
  const publicAccess = await request(publicItems, bearer(secret));
  assert.equal(publicAccess.status, 200);
  const fake = 'fake-token-that-must-never-appear-in-request-records';
  const fallback = await request(publicItems, { headers: { Authorization: `Bearer ${fake}`, Cookie: cookie } });
  assert.equal(fallback.status, 200);
  const ids = [admitted, rejected, publicAccess, fallback].map((response) => response.headers.get('x-request-id'));
  for (const requestId of ids) assert.match(requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(new Set(ids).size, ids.length);
  const output = compose('logs', '--no-color', '--no-log-prefix', 'access', 'caddy');
  for (const value of [secret, cookie, fake, claims]) assert.equal(output.includes(value), false);
  const byId = new Map(output.split(/\r?\n/).filter((line) => line.startsWith('{"event":"publication.request"'))
    .map((line) => JSON.parse(line)).map(({ requestId, event, ...entry }) => [requestId, entry]));
  assert.deepEqual(byId.get(ids[0]), { publicationId: 'private-places', userId, tokenId: id, status: 200 });
  assert.deepEqual(byId.get(ids[1]), { publicationId: 'other-private', userId, tokenId: id, status: 403 });
  assert.deepEqual(byId.get(ids[2]), { publicationId: 'places', userId, tokenId: id, status: 200 });
  assert.deepEqual(byId.get(ids[3]), { publicationId: 'places', status: 200 });
  const gatewayLog = gatewayRecords(output);
  for (const [index, [publicationId, status]] of [['private-places', 200], ['other-private', 403],
    ['places', 200], ['places', 200]].entries()) {
    assert.equal(gatewayLog.get(ids[index])?.publicationId, publicationId);
    assert.equal(gatewayLog.get(ids[index])?.status, status);
  }
});

function gatewayRecords(log) {
  return new Map(log.split(/\r?\n/).filter((line) => line.includes('"logger":"http.log.access"'))
    .map((line) => JSON.parse(line)).map((entry) => [entry.requestId, entry]));
}

test('anonymous visitors receive 401 for a private publication and cannot see it in shared descriptions', async () => {
  const items = await fetch(`${gateway}${privateCollection}/items?f=json`);
  assert.equal(items.status, 401);
  assert.match(items.headers.get('www-authenticate'), /^Session\b/);
  assert.equal(items.headers.get('cache-control'), 'no-store');
  assert.equal((await items.json()).code, 'Unauthorized');

  const catalog = await fetch(`${gateway}/pygeoapi/features/collections?f=json`);
  assert.equal(catalog.status, 200);
  assert.deepEqual((await catalog.json()).collections.map(({ id }) => id), ['places']);
  const openapi = await fetch(`${gateway}/pygeoapi/features/openapi?f=json`);
  assert.equal(openapi.status, 200);
  assert.doesNotMatch(await openapi.text(), /private-places|other-private/);
});

test('personal grants and revocations apply to the next request for exactly one publication', async () => {
  const email = '-grantee@example.test';
  await register(email, password, 'Grant reader');
  const cookie = await signIn(email, password);
  const options = { headers: { Cookie: cookie } };
  const landing = async (sessionOptions) => {
    const response = await request('/', sessionOptions);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^text\/html/);
    return response.text();
  };
  const guest = await landing();
  assert.match(guest, /\/account\/register/);
  assert.match(guest, /\/account\/login/);
  assert.match(guest, /\/pygeoapi\/features\/collections\/places/);
  assert.doesNotMatch(guest, /registered-places|private-places|other-private/);
  assert.match(await landing(options), /\/pygeoapi\/features\/collections\/registered-places/);
  const other = '/pygeoapi/features/collections/other-private/items/central?f=json';
  assert.equal((await request(items, options)).status, 403);
  const grant = cli(['access', 'grant', 'private-places', '--email', '-GRANTEE@EXAMPLE.TEST']);
  assert.ok(grant.userId);
  assert.equal(grant.publicationId, 'private-places');
  const personalized = await landing(options);
  assert.ok(personalized.includes(`href="${gateway}${privateCollection}"`));
  assert.doesNotMatch(personalized, /other-private/);
  cli(['access', 'grant', 'private-places', '--user-id', grant.userId], 'NO_CHANGE');
  const response = await request(items, options);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'central');
  assert.equal((await request(other, options)).status, 403);
  const detail = await request(`${privateCollection}?f=json`, options);
  assert.equal(detail.status, 200);
  const linked = new URL((await detail.json()).links.find(({ rel, type }) => rel === 'items' && type === 'application/geo+json').href);
  assert.equal(linked.origin, gateway);
  linked.searchParams.set('limit', '1');
  const page = await request(linked, options);
  assert.equal(page.status, 200);
  const next = (await page.json()).links.find(({ rel }) => rel === 'next').href;
  assert.equal((await request(next, options)).status, 200);

  const catalog = await request('/pygeoapi/features/collections', { headers: { Cookie: cookie, Accept: 'application/ld+json' } });
  assert.deepEqual((await catalog.json()).dataset.map((entry) => new URL(entry['@id']).pathname), [
    '/pygeoapi/features/collections/registered-places', '/pygeoapi/features/collections/places', privateCollection,
  ]);
  const api = await request('/pygeoapi/features/openapi?f=json', options);
  const openapi = await api.json();
  const operation = openapi.paths['/collections/private-places/items'].get;
  assert.deepEqual(operation.security, [{ session: [] }, { bearer: [] }]);
  assert.ok(operation.responses['401'].headers['WWW-Authenticate']);
  assert.ok(operation.responses['403']);
  assert.ok(operation.responses['503']);
  assert.doesNotMatch(JSON.stringify(openapi), /other-private|Other closed places/);

  cli(['access', 'revoke', 'private-places', '--user-id', grant.userId]);
  assert.doesNotMatch(await landing(options), /private-places/);
  cli(['access', 'revoke', 'private-places', '--user-id', grant.userId], 'NO_CHANGE');
  assert.equal((await request(items, options)).status, 403);
  assert.equal((await request(next, options)).status, 403);
  for (const path of ['/pygeoapi/features/collections?f=html', '/pygeoapi/features/openapi?f=yaml']) {
    const metadata = await request(path, options);
    assert.equal(metadata.status, 200);
    assert.doesNotMatch(await metadata.text(), /private-places|Closed places/);
  }
});

test('a confirmed administrator can read all modes and an ordinary account lacks private access', async () => {
  for (const email of ['ordinary@example.test', 'administrator@example.test']) {
    await register(email, password);
  }
  const ordinary = await signIn('ordinary@example.test', password);
  const administrator = await signIn('administrator@example.test', password);
  const denied = await request(items, { headers: { Cookie: ordinary } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'Forbidden');
  assert.equal(denied.headers.get('www-authenticate'), null);

  const allowed = await request(items, { headers: { Cookie: administrator } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).id, 'central');
  const catalog = await request('/pygeoapi/features/collections?f=json', { headers: { Cookie: administrator } });
  assert.deepEqual((await catalog.json()).collections.map(({ id }) => id),
    ['registered-places', 'places', 'private-places', 'other-private']);
  const api = await request('/pygeoapi/features/openapi?f=json', { headers: { Cookie: administrator } });
  assert.ok((await api.json()).paths['/collections/other-private/items']);
  const head = await request(items, { method: 'HEAD', headers: { Cookie: administrator } });
  assert.equal(head.status, 200);
  cli(['users', 'block', '--email', 'administrator@example.test']);
  assert.equal((await request(items, { headers: { Cookie: administrator } })).status, 403);
  const users = cli(['users', 'list']).users;
  assert.deepEqual(publications(users.find(({ email }) => email === 'administrator@example.test')), ['places']);
  cli(['users', 'unblock', '--email', 'administrator@example.test']);
});

test('authorized operators export user access to an Excel workbook', async () => {
  const email = 'export-reader@example.test';
  await register(email, password, '=1+1');
  cli(['access', 'grant', 'private-places', '--email', email]);
  const file = join(process.env.GIS_TEST_RESULTS, 'users.xlsx');

  cli(['users', 'list', '--xlsx', file], 'FORBIDDEN', 4, operator('agent'));
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const output = cli(['users', 'list', '--xlsx', file], 'OK', 0, operator('reader'));
  assert.equal(output.file, file);
  assert.ok(output.count >= 1);
  const { strFromU8, unzipSync } = await import('fflate');
  const workbook = unzipSync(await readFile(file));
  assert.ok(workbook['xl/workbook.xml']);
  const sheets = Object.entries(workbook).filter(([name]) => /^xl\/(worksheets\/sheet\d+|sharedStrings)\.xml$/.test(name))
    .map(([, content]) => strFromU8(content)).join('\n');
  assert.match(sheets, /export-reader@example\.test/);
  assert.match(sheets, /=1\+1/);
  assert.doesNotMatch(sheets, /<f[ >]/);
  assert.match(sheets, /private-places/);
  cli(['users', 'list', '--xlsx', file], 'INVALID_INPUT', 2, operator('reader'));
});

test('user summaries and the gateway reflect blocking and unblocking', async () => {
  const email = 'block-reader@example.test';
  const pending = 'unverified@example.test';
  await register(email, password, 'Block reader');
  const cookie = await signIn(email, password);
  const { user: { id } } = await session(cookie);
  assert.equal((await auth('sign-up/email', { email: pending, password, name: 'Unverified' })).status, 200);
  cli(['access', 'grant', 'private-places', '--email', email]);
  cli(['access', 'grant', 'private-places', '--email', pending]);
  const options = { headers: { Cookie: cookie } };
  assert.equal((await request(items, options)).status, 200);
  const readUser = (email) => cli(['users', 'list']).users.find((user) => user.email === email);
  const active = readUser(email);
  assert.equal(active.id, id);
  assert.equal(active.name, 'Block reader');
  assert.ok(Number.isFinite(Date.parse(active.registeredAt)));
  assert.equal(active.status, 'active');
  assert.deepEqual(publications(active), ['registered-places', 'places', 'private-places']);
  assert.ok(active.publications.every(({ anonymous }) => !anonymous));
  const unverified = readUser(pending);
  assert.equal(unverified.status, 'unverified');
  assert.deepEqual(publications(unverified), ['places']);
  assert.equal(unverified.publications[0].anonymous, true);
  assert.equal((await auth('sign-in/email', { email: pending, password })).status, 403);

  cli(['users', 'block', '--user-id', id]);
  cli(['users', 'block', '--email', email], 'NO_CHANGE');
  assert.equal((await request(items, options)).status, 403);
  assert.equal((await request(publicItems, options)).status, 200);
  assert.equal((await auth('sign-in/email', { email, password })).status, 403);
  const blocked = readUser(email);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(publications(blocked), ['places']);
  assert.equal(blocked.publications[0].anonymous, true);
  cli(['users', 'unblock', '--email', email]);
  const confirmed = await signIn(email, password);
  assert.equal((await request(items, { headers: { Cookie: confirmed } })).status, 200);

});

test('CLI validation and delegation return one JSON result with stable codes', () => {
  assert.equal(cli(['status'], 'OK', 0, operator('agent')).access, 'ready');
  const diagnostics = cli(['doctor', '--publication', 'private-places'], 'OK', 0, operator('agent'));
  assert.equal(diagnostics.publicationId, 'private-places');
  assert.equal(diagnostics.gateway, 'ready');
  assert.deepEqual(diagnostics.publications, [
    { publicationId: 'private-places', instance: 'ready', source: 'ready' },
  ]);
  cli(['doctor', '--publication', 'absent'], 'NOT_FOUND', 3, operator('agent'));
  cli(['users', 'list'], 'FORBIDDEN', 4, operator('agent'));
  cli(['users', 'list'], 'FORBIDDEN', 4, operator('outsider'));
  cli(['users', 'list'], 'FORBIDDEN', 4, { GIS_ADMIN_KEY_FILE: '' });
  assert.ok(Array.isArray(cli(['users', 'list'], 'OK', 0, operator('reader')).users));
  cli(['status'], 'FORBIDDEN', 4, operator('reader'));
  cli(['users', 'block', '--email', 'absent@example.test'], 'FORBIDDEN', 4, operator('reader'));
  cli(['users', 'list'], 'FORBIDDEN', 4, operator('writer'));
  cli(['users', 'block', '--email', 'absent@example.test'], 'NOT_FOUND', 3, operator('writer'));
  cli(['users', 'block', '--email', 'not-an-email'], 'INVALID_INPUT', 2);
  cli(['access', 'grant', 'places', '--email', 'absent@example.test'], 'INVALID_INPUT', 2);
  cli(['access', 'grant', 'absent', '--email', 'absent@example.test'], 'NOT_FOUND', 3);
  cli(['access', 'grant', 'private-places', '--email', 'absent@example.test', '--user-id', 'another'],
    'INVALID_INPUT', 2);
});

test('separate local accounts use one CLI and only their own credentials', () => {
  const accessContainer = compose('ps', '-q', 'access');
  const output = dockerJson('run', '--rm', '--network', `container:${accessContainer}`,
    '--mount', `type=bind,src=${process.env.GIS_TEST_RESULTS},dst=/root/input,readonly`,
    '--entrypoint', '/bin/sh', process.env.GIS_TEST_CLI_IMAGE, 'tests/cli-local-accounts.sh');
  const results = output.split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(results.map(({ code }) => code), ['OK', 'OK', 'FORBIDDEN', 'FORBIDDEN']);
});

test('delegated changes are audited under the authenticated local account', async () => {
  const email = 'audited@example.test';
  await register(email, password, 'Audit reader');
  const { userId } = cli(['access', 'grant', 'private-places', '--email', email], 'OK', 0,
    { ...operator('writer'), USER: 'operator', USERNAME: 'operator', LOGNAME: 'operator' });
  cli(['users', 'block', '--user-id', userId], 'OK', 0, operator('writer'));
  const changes = compose('logs', '--no-color', '--no-log-prefix', 'access').split(/\r?\n/)
    .filter((line) => line.startsWith('{"event":"access.change"'))
    .map((line) => JSON.parse(line)).filter((event) => event.userId === userId);
  assert.deepEqual(changes, [
    { event: 'access.change', actor: 'writer', operation: 'access grant', userId, publicationId: 'private-places' },
    { event: 'access.change', actor: 'writer', operation: 'users block', userId },
  ]);
});

test('a grant survives access service recreation and dependency outages fail closed', async () => {
  const email = 'persistent-private@example.test';
  await register(email, password);
  const cookie = await signIn(email, password);
  const options = { headers: { Cookie: cookie } };
  cli(['access', 'grant', 'private-places', '--email', email]);
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'access');
  assert.equal((await request(items, options)).status, 200);
  for (const service of ['postgres', 'access']) {
    compose('stop', service);
    try {
      const deniedIds = [];
      for (const requestOptions of [options, undefined]) {
        for (const path of [items, '/pygeoapi/features/collections?f=json', '/pygeoapi/features/openapi?f=json']) {
          const unavailable = await request(path, requestOptions);
          assert.equal(unavailable.status, 503, `${service}: ${path}`);
          assert.equal(unavailable.headers.get('cache-control'), 'no-store');
          assert.equal((await unavailable.json()).code, 'ServiceUnavailable');
          if (path === items) {
            const requestId = unavailable.headers.get('x-request-id');
            assert.match(requestId, /^[0-9a-f-]{36}$/i, `${service}: ${path}`);
            deniedIds.push(requestId);
          }
        }
      }
      const publicResponse = await request(publicItems, options);
      assert.equal(publicResponse.status, 200);
      const log = gatewayRecords(compose('logs', '--no-color', '--no-log-prefix', 'caddy'));
      for (const id of deniedIds) {
        assert.equal(log.get(id)?.publicationId, 'private-places');
        assert.equal(log.get(id)?.status, 503);
      }
      assert.equal(log.get(publicResponse.headers.get('x-request-id'))?.publicationId, 'places');
      cli(['users', 'list'], 'FAILED', 1);
    } finally {
      compose('up', '-d', '--wait', service);
    }
  }
  assert.equal((await request(items, options)).status, 200);
  assert.equal((await request('/command', { method: 'POST' })).status, 404);
  assert.equal((await request('/internal/authorize/private-places', options)).status, 404);
});

function freshGet(path, headers, expected, readBody = false) {
  return new Promise((resolve, reject) => {
    const req = get(new URL(path, gateway), { headers, agent: false, signal: AbortSignal.timeout(5000) }, (response) => {
      if (response.statusCode !== expected) {
        response.resume();
        reject(new Error(`${path}: expected ${expected}, received ${response.statusCode}`));
      } else if (readBody) {
        json(response).then(resolve, reject);
      } else {
        response.resume();
        resolve();
      }
    });
    req.on('error', reject);
  });
}

async function planPrivateConfig(edit, expected = 'OK', exitCode = 0) {
  const filename = process.env.GIS_TEST_CONFIG;
  const draft = parse(await readFile(filename, 'utf8'));
  edit(draft);
  const candidate = join(dirname(filename), 'publication-lifecycle.yaml');
  await writeFile(candidate, stringify(draft));
  return cli(['config', 'plan', candidate], expected, exitCode);
}

test('deleting and restoring a private publication drops its grants and keeps the source', async () => {
  const email = 'publication-restore@example.test';
  const other = 'other-private';
  await register(email, password);
  const cookie = await signIn(email, password);
  const token = await createToken(cookie, 'Publication lifecycle');
  const headers = bearer(token.secret).headers;
  cli(['access', 'grant', 'private-places', '--email', email]);
  cli(['access', 'grant', other, '--email', email]);
  await freshGet(items, headers, 200);
  const { currentVersion } = cli(['status']);

  const workingFile = process.env.GIS_TEST_CONFIG;
  const originalYaml = await readFile(workingFile, 'utf8');
  const reviewed = parse(originalYaml);
  delete reviewed.publications['private-places'];
  const reviewedFile = join(dirname(workingFile), 'reviewed-removal.yaml');
  const reviewedYaml = stringify(reviewed);
  await writeFile(reviewedFile, reviewedYaml);
  const { draftFile } = cli(['draft', 'access', workingFile, 'private-places', 'private']);
  cli(['draft', 'rebase', workingFile, reviewedFile]);
  const removal = cli(['config', 'plan', '--draft', workingFile]);
  assert.deepEqual(removal.removed, ['private-places']);
  assert.ok(removal.routesToClose.includes(new URL(privateCollection, gateway).href));
  assert.deepEqual(removal.publications.find(({ publicationId }) => publicationId === 'private-places'), {
    publicationId: 'private-places', previousUrl: new URL(privateCollection, gateway).href,
    newUrl: null, previousAccess: 'private', newAccess: null, personalGrants: 'delete',
  });
  await freshGet(items, headers, 200);

  cli(['config', 'apply', removal.planId]);
  assert.equal(await readFile(workingFile, 'utf8'), reviewedYaml);
  await assert.rejects(readFile(draftFile), { code: 'ENOENT' });
  for (const path of [items, privateCollection, `${privateCollection}/schema`, `${privateCollection}/queryables`]) {
    await freshGet(path, headers, 404);
  }
  const catalog = await freshGet('/pygeoapi/features/collections?f=json', headers, 200, true);
  assert.ok(!catalog.collections.some(({ id }) => id === 'private-places'));
  assert.ok(catalog.collections.some(({ id }) => id === other));
  const api = await freshGet('/pygeoapi/features/openapi?f=json', headers, 200, true);
  assert.ok(!Object.keys(api.paths).some((path) => path.startsWith('/collections/private-places')));
  cli(['access', 'grant', 'private-places', '--email', email], 'NOT_FOUND', 3);
  await freshGet(publicItems, {}, 200);

  const restore = cli(['config', 'plan', '--rollback-to', currentVersion]);
  assert.deepEqual(restore.added, ['private-places']);
  cli(['config', 'apply', restore.planId]);
  await writeFile(workingFile, originalYaml);
  await freshGet(items, headers, 403);
  cli(['access', 'grant', 'private-places', '--email', email]);
  assert.equal((await freshGet(items, headers, 200, true)).id, 'central');
  cli(['config', 'apply', removal.planId]);
  await freshGet(items, headers, 200);
  cli(['access', 'revoke', 'private-places', '--email', email]);
  cli(['access', 'revoke', other, '--email', email]);
});

test('a failed switch that would remove a publication keeps its data and grants', async () => {
  const email = 'failed-publication-removal@example.test';
  await register(email, password);
  const headers = { Cookie: await signIn(email, password) };
  cli(['access', 'grant', 'private-places', '--email', email]);
  const { currentVersion } = cli(['status']);
  const removal = await planPrivateConfig(({ auth, publications, server }) => {
    delete publications['private-places'];
    server.port = auth.mailpit_port;
  });
  cli(['config', 'apply', removal.planId], 'APPLY_FAILED', 6);
  assert.equal(cli(['status']).currentVersion, currentVersion);
  await freshGet(items, headers, 200);
  const catalog = await freshGet('/pygeoapi/features/collections?f=json', headers, 200, true);
  assert.ok(catalog.collections.some(({ id }) => id === 'private-places'));
  cli(['access', 'revoke', 'private-places', '--email', email]);
});

test('a database error deleting publication grants rolls back the candidate', async () => {
  const email = 'failed-grant-deletion@example.test';
  await register(email, password);
  const headers = { Cookie: await signIn(email, password) };
  cli(['access', 'grant', 'private-places', '--email', email]);
  const { currentVersion } = cli(['status']);
  const sql = (...args) => compose('exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'gis', '-d', 'gis', ...args);
  sql('-c', `
    CREATE FUNCTION reject_test_grant_deletion() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'injected storage error'; RETURN NULL; END $$;
    CREATE TRIGGER reject_test_grant_deletion BEFORE DELETE ON publication_grant
      FOR EACH ROW EXECUTE FUNCTION reject_test_grant_deletion();
  `);
  try {
    const removal = await planPrivateConfig(({ publications }) => { delete publications['private-places']; });
    cli(['config', 'apply', removal.planId], 'APPLY_FAILED', 6);
    assert.equal(cli(['status']).currentVersion, currentVersion);
    await freshGet(items, headers, 200);
  } finally {
    sql('-c', 'DROP TRIGGER reject_test_grant_deletion ON publication_grant; DROP FUNCTION reject_test_grant_deletion()');
  }
  cli(['access', 'revoke', 'private-places', '--email', email]);
});

test('a removed publication ID stays reserved for its source and protocol', async () => {
  const { currentVersion } = cli(['status']);
  const removal = await planPrivateConfig(({ publications }) => { delete publications['private-places']; });
  cli(['config', 'apply', removal.planId]);

  const assignNewSource = (draft) => {
    draft.sources = { replacement: { type: 'geojson', path: 'replacement.geojson' } };
    draft.publications = { 'private-places': { ...draft.publications['private-places'], source: 'replacement' } };
  };
  const rejected = await planPrivateConfig(assignNewSource, 'INVALID_CONFIG', 2);
  assert.match(rejected.message, /'private-places' is reserved/);
  const retargeted = await planPrivateConfig((draft) => {
    Object.values(draft.sources)[0].path = 'replacement.geojson';
    draft.publications = { 'private-places': draft.publications['private-places'] };
  }, 'INVALID_CONFIG', 2);
  assert.match(retargeted.message, /'private-places' is reserved/);
  await planPrivateConfig(({ publications }) => {
    publications['private-places'].protocol = 'tiles';
  }, 'INVALID_CONFIG', 2);
  assert.equal(cli(['status']).currentVersion, removal.planId);

  const restore = cli(['config', 'plan', '--rollback-to', currentVersion]);
  cli(['config', 'apply', restore.planId]);
  const renamed = await planPrivateConfig(({ publications }) => { publications.places.title = 'Renamed public places'; });
  const publication = renamed.publications.find(({ publicationId }) => publicationId === 'places');
  assert.equal(publication.newUrl, publication.previousUrl);
  cli(['config', 'apply', renamed.planId]);
  const collection = await freshGet('/pygeoapi/features/collections/places?f=json', {}, 200, true);
  assert.equal(collection.id, 'places');
  assert.equal(collection.title, 'Renamed public places');
  cli(['config', 'apply', cli(['config', 'plan', '--rollback-to', currentVersion]).planId]);
});

test('all publications can be removed together with auth and restored without their grants', async () => {
  const email = 'last-publication@example.test';
  await register(email, password);
  const headers = { Cookie: await signIn(email, password) };
  cli(['access', 'grant', 'private-places', '--email', email]);
  const { currentVersion } = cli(['status']);
  const removeAll = await planPrivateConfig((draft) => {
    draft.publications = {};
    delete draft.auth;
  });
  assert.deepEqual(removeAll.removed, ['registered-places', 'places', 'private-places', 'other-private']);
  assert.equal(removeAll.newUrl, null);
  cli(['config', 'apply', removeAll.planId]);
  assert.deepEqual((await freshGet('/pygeoapi/features/collections?f=json', {}, 200, true)).collections, []);
  await freshGet(publicItems, {}, 404);
  await freshGet(items, headers, 404);

  cli(['config', 'apply', cli(['config', 'plan', '--rollback-to', currentVersion]).planId]);
  await freshGet(publicItems, {}, 200);
  await freshGet(items, headers, 403);
});

test('rolling back a publication keeps the current account, token and grant revocation', async () => {
  const email = 'configuration-rollback@example.test';
  await register(email, password);
  const cookie = await signIn(email, password);
  cli(['access', 'grant', 'private-places', '--email', email]);
  const token = await createToken(cookie, 'Retained by config rollback');
  await freshGet(items, bearer(token.secret).headers, 200);

  const { currentVersion } = cli(['status']);
  const filename = process.env.GIS_TEST_CONFIG;
  const original = await readFile(filename, 'utf8');
  let update;
  try {
    await writeFile(filename, original.replace('title: Closed places', 'title: Renamed closed places'));
    update = cli(['config', 'plan', filename]);
  } finally {
    await writeFile(filename, original);
  }
  assert.deepEqual(update.changed, ['private-places']);
  assert.equal(update.publications.find(({ publicationId }) => publicationId === 'private-places').personalGrants, 'preserve');
  cli(['config', 'apply', update.planId]);
  await freshGet(items, bearer(token.secret).headers, 200);
  cli(['access', 'revoke', 'private-places', '--email', email]);
  cli(['users', 'block', '--email', email]);

  const rollback = cli(['config', 'plan', '--rollback-to', currentVersion]);
  cli(['config', 'apply', rollback.planId]);
  await freshGet(items, bearer(token.secret).headers, 403);
  cli(['users', 'unblock', '--email', email]);
  const listing = await freshGet('/api/auth/tokens', { Cookie: cookie }, 200, true);
  assert.equal(listing.tokens.some(({ id }) => id === token.id), true);
  await freshGet(items, bearer(token.secret).headers, 403);
  cli(['access', 'grant', 'private-places', '--email', email]);
  await freshGet(items, bearer(token.secret).headers, 200);
  cli(['access', 'revoke', 'private-places', '--email', email]);
});

test('an unavailable unchanged source does not block an access-only change or the saved OpenAPI', async () => {
  const filename = process.env.GIS_TEST_CONFIG;
  const source = join(dirname(filename), 'places.geojson');
  const moved = `${source}.test-backup`;
  const original = await readFile(filename, 'utf8');
  const updated = original.replace('[administrator@example.test]', '[administrator@example.test, another@example.test]');
  assert.notEqual(updated, original);
  await rename(source, moved);
  try {
    await writeFile(filename, updated);
    const plan = cli(['config', 'plan', filename]);
    assert.ok(plan.services.includes('access'));
    assert.ok(!plan.services.includes('pygeoapi'));
    cli(['config', 'apply', plan.planId]);
    const api = await freshGet('/pygeoapi/features/openapi?f=json', {}, 200, true);
    assert.ok(api.paths['/collections/places/items']);
    await freshGet(items, {}, 401);
  } finally {
    await rename(moved, source);
    await writeFile(filename, original);
  }
});

test('moving a private publication between provider instances preserves its URL, ID, and current grant', async () => {
  const filename = process.env.GIS_TEST_CONFIG;
  const draft = parse(await readFile(filename, 'utf8'));
  const platform = join(dirname(filename), 'provider-transfer.yaml');
  const integration = join(dirname(filename), 'provider-transfer-integration.yaml');
  const features = {
    type: 'pygeoapi',
    api: { protocol: 'features', scheme: 'http', port: 8082, base_path: '/', public_root: '/pygeoapi/features',
      links: 'canonical', readiness: '/openapi?f=json' },
  };
  const image = 'geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a';
  draft.providers[draft.publications['private-places'].provider] = { ...features, image };
  await writeFile(platform, stringify(draft));
  await writeFile(integration, stringify(features));
  cli(['config', 'apply', cli(['config', 'plan', platform]).planId]);
  const email = 'provider-transfer@example.test';
  await register(email, password);
  const cookie = await signIn(email, password);
  const { secret } = await createToken(cookie, 'Provider transfer');
  const { headers } = bearer(secret);
  cli(['access', 'grant', 'private-places', '--email', email]);
  assert.equal((await freshGet(items, headers, 200, true)).id, 'central');
  const { currentVersion: original } = cli(['status']);

  cli(['provider', 'add', 'dedicated', image, integration, platform]);
  const updated = parse(await readFile(platform, 'utf8'));
  updated.publications['private-places'].provider = 'dedicated';
  await writeFile(platform, stringify(updated));
  const transition = cli(['config', 'plan', platform]);
  assert.deepEqual(transition.publications.find(({ publicationId }) => publicationId === 'private-places'), {
    publicationId: 'private-places',
    previousUrl: new URL(privateCollection, gateway).href,
    newUrl: new URL(privateCollection, gateway).href,
    previousAccess: 'private', newAccess: 'private', personalGrants: 'preserve',
  });
  assert.ok(transition.services.includes('provider-dedicated'));
  cli(['config', 'apply', transition.planId]);

  await freshGet(items, {}, 401);
  assert.equal((await freshGet(items, headers, 200, true)).id, 'central');
  for (const authorized of [false, true]) {
    const authHeaders = authorized ? headers : {};
    const catalog = await freshGet('/pygeoapi/features/collections?f=json', authHeaders, 200, true);
    assert.equal(catalog.collections.some(({ id }) => id === 'private-places'), authorized);
    assert.ok(catalog.collections.some(({ id }) => id === 'places'));
    const api = await freshGet('/pygeoapi/features/openapi?f=json', authHeaders, 200, true);
    assert.equal(Boolean(api.paths['/collections/private-places/items']), authorized);
    assert.ok(api.paths['/collections/places/items']);
  }
  await freshGet('/pygeoapi/features/admin', headers, 404);
  cli(['provider', 'update', 'dedicated', platform,
    'docker.io/geopython/pygeoapi:0.24.0@sha256:a62895f2585ef1fcd1fc97ec35bf13177becc1334a622172a2c5c4d2145b8f0a']);
  assert.equal((await freshGet(items, headers, 200, true)).id, 'central');
  cli(['access', 'revoke', 'private-places', '--email', email]);
  await freshGet(items, headers, 403);
  cli(['config', 'apply', cli(['config', 'plan', '--rollback-to', original]).planId]);
  await freshGet(items, headers, 403);
});

test('delegated status reports the confirmed version while gateway routes are closed', async () => {
  const environment = { ...process.env, ...operator('agent'),
    GIS_STATE_DIR: join(process.env.GIS_TEST_RESULTS, 'delegated-status-without-local-state') };
  const { currentVersion } = cli(['status'], 'OK', 0, environment);
  const change = await planPrivateConfig(({ publications }) => {
    publications['private-places'].title = 'Renamed private places';
  });
  const worker = spawn(process.execPath, ['dist/cli.js', 'config', 'apply', change.planId, '--json'], { windowsHide: true });
  const done = once(worker, 'close');
  let output = '';
  worker.stdout.on('data', (chunk) => { output += chunk; });
  let during;
  for (let attempt = 0; attempt < 80 && worker.exitCode === null; attempt++) {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'status', '--json'], {
      env: environment, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.ifError(result.error);
    const reply = JSON.parse(result.stdout);
    if (reply.data.phase === 'switch' && reply.data.closedRoutes?.length) {
      during = reply.data;
      break;
    }
    await setTimeout(100);
  }
  const [exitCode] = await done;
  assert.equal(exitCode, 0, output);
  assert.equal(during?.currentVersion, currentVersion);
  assert.ok(during.closedRoutes.includes(new URL(privateCollection, gateway).href));
  const settled = cli(['status'], 'OK', 0, environment);
  assert.equal(settled.currentVersion, change.planId);
  assert.deepEqual(settled.closedRoutes, []);
});
