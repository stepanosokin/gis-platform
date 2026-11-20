import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';

const gateway = process.env.GIS_TEST_PUBLIC_URL;
const mailpit = process.env.GIS_TEST_MAILPIT;

function request(path, options) {
  return fetch(new URL(path, gateway), { signal: AbortSignal.timeout(10_000), ...options });
}

async function auth(endpoint, body, cookie, origin = gateway) {
  const url = new URL(`/api/auth/${endpoint}`, origin);
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie && { Cookie: cookie }) },
    body: JSON.stringify(body),
  };
  const response = await request(url, options);
  if (response.status !== 429) return response;

  const delay = Number(response.headers.get('X-Retry-After'));
  assert.ok(delay > 0 && delay <= 60);
  await response.body?.cancel();
  await setTimeout(delay * 1000 + 100);
  return request(url, options);
}

function cookieFrom(response) {
  const session = response.headers.getSetCookie().find((value) => /^(?:__Secure-)?gis\.session_token=/.test(value));
  assert.ok(session, 'expected a session cookie');
  return session.split(';')[0];
}

async function emailLink(address, path) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = await fetch(`${mailpit}/api/v1/messages`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(result.status, 200);
    const { messages } = await result.json();
    for (const message of messages.filter(({ To }) => To.some(({ Address }) => Address === address))) {
      const detail = await fetch(`${mailpit}/api/v1/message/${message.ID}`);
      assert.equal(detail.status, 200);
      const link = (await detail.json()).Text.match(/https?:\/\/[^\s]+/)?.[0];
      if (link && new URL(link).pathname === path) return link;
    }
    await setTimeout(200);
  }
  assert.fail(`No ${path} email for ${address}`);
}

test('a visitor registers, verifies email and signs in at the platform URL', async () => {
  const email = 'reader@example.test';
  const password = 'reader-password-15';
  const registration = await request('/account/register');
  assert.equal(registration.status, 200);
  assert.match(await registration.text(), /<form\b/);

  assert.equal((await auth('sign-up/email', { email, password, name: 'Reader' })).status, 200);
  assert.equal((await auth('sign-in/email', { email, password })).status, 403);

  const link = await emailLink(email, '/api/auth/verify-email');
  assert.equal(new URL(link).origin, gateway);
  const verification = await request(link);
  assert.equal(verification.status, 200);
  assert.match(await verification.text(), /email is verified/i);

  const login = await auth('sign-in/email', { email, password });
  assert.equal(login.status, 200);
  assert.equal(Object.hasOwn(await login.json(), 'token'), false);
  const session = login.headers.getSetCookie().find((value) => value.startsWith('gis.session_token='));
  assert.match(session, /; HttpOnly\b/i);
  assert.match(session, /; SameSite=Lax\b/i);
});

async function register(email, password, name = 'Reader') {
  assert.equal((await auth('sign-up/email', { email, password, name })).status, 200);
  const link = await emailLink(email.toLowerCase(), '/api/auth/verify-email');
  assert.equal((await request(link)).status, 200);
}

async function signIn(email, password) {
  const response = await auth('sign-in/email', { email, password });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

async function session(cookie) {
  const response = await request('/api/auth/get-session', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

test('the profile keeps a stable ID and immutable normalized email while names may repeat', async () => {
  const password = 'profile-password-15';
  await register('Person.Name+Map@EXAMPLE.TEST', password, 'Common name');
  await register('personname@example.test', password, 'Common name');
  const cookie = await signIn('PERSON.NAME+MAP@EXAMPLE.TEST', password);
  const before = (await session(cookie)).user;
  assert.ok(before.id);
  assert.equal(before.email, 'person.name+map@example.test');
  const other = (await session(await signIn('personname@example.test', password))).user;
  assert.notEqual(before.id, other.id);

  assert.equal((await request('/account/profile', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await auth('update-user', { name: 'Different name' }, cookie)).status, 200);
  assert.equal((await auth('change-email', { newEmail: 'other@example.test' }, cookie)).status, 404);
  const update = await auth('update-user', { email: 'other@example.test' }, cookie);
  assert.ok(update.status >= 400 && update.status < 500);
  await auth('sign-up/email', { email: 'person.name+MAP@example.test', password: 'different-password-15', name: 'Duplicate' });
  assert.equal((await auth('sign-in/email', { email: before.email, password: 'different-password-15' })).status, 401);
  const updated = (await session(cookie)).user;
  assert.deepEqual([updated.id, updated.email, updated.name], [before.id, before.email, 'Different name']);
});

test('password change and email recovery revoke all previous sessions', async () => {
  const email = 'passwords@example.test';
  const initial = 'initial-password-15';
  const changed = 'changed-password-15';
  const recovered = 'recovered-password-15';
  await register(email, initial);
  const current = await signIn(email, initial);
  const other = await signIn(email, initial);
  assert.notEqual(current, other);

  const changePage = await request('/account/change-password', { headers: { Cookie: current } });
  assert.equal(changePage.status, 200);
  assert.match(await changePage.text(), /name="currentPassword"/);
  const invalid = await auth('change-password', { currentPassword: 'wrong-password', newPassword: changed }, current);
  assert.equal(invalid.status, 400);
  assert.ok((await session(other)).user);

  const change = await auth('change-password', { currentPassword: initial, newPassword: changed, revokeOtherSessions: false }, current);
  assert.equal(change.status, 200);
  const retained = cookieFrom(change);
  assert.equal(Object.hasOwn(await change.json(), 'token'), false);
  assert.ok((await session(retained)).user);
  assert.equal(await session(other), null);
  assert.equal(await session(current), null);
  assert.equal((await auth('sign-in/email', { email, password: initial })).status, 401);

  const second = await signIn(email, changed);
  assert.equal((await request('/account/forgot-password')).status, 200);
  assert.equal((await auth('request-password-reset', { email })).status, 200);
  const link = new URL(await emailLink(email, '/account/reset-password'));
  assert.equal(link.origin, gateway);
  const resetPage = await request(link.href);
  assert.equal(resetPage.status, 200);
  assert.equal(resetPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await resetPage.text(), /name="newPassword"/);
  const token = link.searchParams.get('token');
  assert.ok(token);
  assert.equal((await auth('reset-password', { token, newPassword: recovered })).status, 200);
  assert.equal((await auth('reset-password', { token, newPassword: initial })).status, 400);
  assert.equal(await session(retained), null);
  assert.equal(await session(second), null);
  assert.equal((await auth('sign-in/email', { email, password: changed })).status, 401);
  assert.ok(await signIn(email, recovered));
});

const collection = '/features/collections/registered-places';

function features(path, cookie) {
  return request(path, cookie ? { headers: { Cookie: cookie } } : undefined);
}

async function document(path, cookie) {
  const response = await features(path, cookie);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
  return response.json();
}

test('the catalog, OpenAPI and related URLs reflect the current session', async () => {
  const anonymous = await document('/features/collections?f=json');
  assert.deepEqual(anonymous.collections.map(({ id }) => id), ['places']);
  const jsonLdUrl = anonymous.links.find(({ type }) => type === 'application/ld+json').href;
  const publicLinkedData = await features(jsonLdUrl);
  assert.equal(publicLinkedData.status, 200);
  assert.match(publicLinkedData.headers.get('content-type'), /^application\/ld\+json/);
  assert.deepEqual((await publicLinkedData.json()).dataset.map((item) => item['@id']), [`${gateway}/features/collections/places`]);
  const html = await features('/features/collections?f=html');
  assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.doesNotMatch(await html.text(), /registered-places|Registered example/);
  const openapi = await document('/features/openapi?f=json');
  assert.match(openapi.openapi, /^3\.0\./);
  assert.ok(openapi.paths['/collections/places/items']);
  assert.doesNotMatch(JSON.stringify(openapi), /registered-places|Registered example/);
  assert.equal((await document('/features/collections/places/items/central?f=json', 'gis.session_token=invalid')).id, 'central');

  for (const suffix of ['', '/items', '/items/central', '/schema', '/queryables']) {
    const denied = await features(`${collection}${suffix}?f=json`, 'gis.session_token=invalid');
    assert.equal(denied.status, 401, suffix);
    assert.match(denied.headers.get('www-authenticate'), /^Session\b/);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal((await denied.json()).code, 'Unauthorized');
  }
  assert.equal((await features('/collections/registered-places/items')).status, 404);
  assert.equal((await features('/internal/authorize')).status, 404);

  await register('features@example.test', 'features-password-15');
  const cookie = await signIn('features@example.test', 'features-password-15');
  const catalog = await document('/features/collections?f=json', cookie);
  assert.deepEqual(catalog.collections.map(({ id }) => id), ['registered-places', 'places']);
  const linkedData = await request('/features/collections', { headers: { Accept: 'application/ld+json', Cookie: cookie } });
  assert.match(linkedData.headers.get('content-type'), /^application\/ld\+json/);
  assert.deepEqual((await linkedData.json()).dataset.map((item) => item['@id']), [
    `${gateway}${collection}`, `${gateway}/features/collections/places`,
  ]);
  const authenticatedHtml = await features('/features/collections?f=html', cookie);
  assert.match(await authenticatedHtml.text(), /registered-places/);
  const api = await document('/features/openapi?f=json', cookie);
  const operation = api.paths['/collections/registered-places/items'].get;
  assert.deepEqual(api.servers.map(({ url }) => url), [`${gateway}/features`]);
  assert.ok(operation.responses['401'].headers['WWW-Authenticate']);
  assert.ok(operation.responses['503']);
  assert.equal(api.components.securitySchemes.session.in, 'cookie');
  assert.deepEqual(operation.security, [{ session: [] }]);
  assert.equal(api.paths['/collections/places/items'].get.security, undefined);
  for (const id of ['places', 'registered-places']) {
    const itemsPage = await features(`/features/collections/${id}/items?f=html`, cookie);
    assert.equal(itemsPage.status, 200);
    assert.match(itemsPage.headers.get('content-security-policy'), /script-src 'none'/);
    await itemsPage.body?.cancel();
  }

  const detail = await document(`${collection}?f=json`, cookie);
  const items = new URL(detail.links.find(({ rel, type }) => rel === 'items' && type === 'application/geo+json').href);
  assert.equal(items.origin, gateway);
  items.searchParams.set('limit', '1');
  const first = await document(items.href, cookie);
  const next = new URL(first.links.find(({ rel }) => rel === 'next').href);
  assert.equal(next.origin, gateway);
  assert.deepEqual((await document(next.href, cookie)).features.map(({ id }) => id), ['area/east']);
  assert.equal((await features(next.href)).status, 401);
});

function compose(...args) {
  const result = spawnSync('docker', ['compose', '-f', 'compose.yaml', '-f', 'compose.auth.yaml', '-f',
    'compose.mailpit.yaml', ...args], { encoding: 'utf8', timeout: 40_000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('blocking a confirmed account takes effect on the next request with its existing session', async () => {
  const email = 'blocked@example.test';
  const password = 'blocked-password-15';
  await register(email, password);
  const cookie = await signIn(email, password);
  assert.equal((await document(`${collection}/items/central?f=json`, cookie)).id, 'central');

  compose('exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'gis', '-d', 'gis',
    '-c', `UPDATE "user" SET active = false WHERE email = '${email}';`);
  const denied = await features(`${collection}/items/central?f=json`, cookie);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'Forbidden');
  assert.equal(await session(cookie), null);
  assert.equal((await auth('sign-in/email', { email, password })).status, 403);
  assert.deepEqual((await document('/features/collections?f=json', cookie)).collections.map(({ id }) => id), ['places']);
});

test('account and session are preserved when PostgreSQL and access containers are recreated', async () => {
  const email = 'persistent@example.test';
  const password = 'persistent-password-15';
  await register(email, password, 'Persistent reader');
  const cookie = await signIn(email, password);
  const prior = (await session(cookie)).user;
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'postgres');
  compose('up', '-d', '--no-deps', '--force-recreate', '--wait', 'access');
  const existing = (await session(cookie)).user;
  assert.deepEqual([existing.id, existing.email, existing.name], [prior.id, email, 'Persistent reader']);
  assert.equal((await session(await signIn(email, password))).user.id, prior.id);
  assert.equal((await document(`${collection}/items/central?f=json`, cookie)).id, 'central');
});

test('access and PostgreSQL outages return Features 503 and leave public data available', async () => {
  const email = 'outage@example.test';
  const password = 'outage-password-15';
  await register(email, password);
  const cookie = await signIn(email, password);
  for (const component of ['access', 'postgres']) {
    compose('stop', component);
    try {
      for (const path of [`${collection}/items?f=json`, '/features/collections?f=json', '/features/openapi?f=json']) {
        const response = await features(path, cookie);
        assert.equal(response.status, 503, `${component}: ${path}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).code, 'ServiceUnavailable');
      }
      const anonymous = await features(`${collection}/items?f=json`);
      assert.equal(anonymous.status, 503);
      assert.equal((await anonymous.json()).code, 'ServiceUnavailable');
      const login = await auth('sign-in/email', { email, password });
      assert.equal(login.status, 503);
      assert.equal((await login.json()).code, 'ServiceUnavailable');
      assert.equal((await document('/features/collections/places/items/central?f=json')).id, 'central');
    } finally {
      compose('up', '-d', '--no-deps', '--wait', component);
    }
    assert.equal((await document(`${collection}/items/central?f=json`, cookie)).id, 'central');
  }
});

function cli(...args) {
  const result = spawnSync(process.execPath, ['dist/cli.js', 'config', ...args, '--json'], {
    encoding: 'utf8', timeout: 100_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).data;
}

test('HTTPS serves the account flow with a Secure session cookie', async () => {
  const filename = process.env.GIS_TEST_CONFIG;
  const current = await readFile(filename, 'utf8');
  await writeFile(filename, current.replace('  host: localhost\n',
    '  host: localhost\n  tls:\n    cert_file: https-cert.pem\n    key_file: https-key.pem\n'));
  const plan = cli('plan', filename);
  cli('apply', plan.planId);
  const origin = gateway.replace('http:', 'https:');
  assert.equal(plan.newUrl, `${origin}${collection}`);
  assert.equal((await request(`${origin}/account/login`)).status, 200);
  const plainHttp = await request('/account/login').catch(() => null);
  assert.ok(plainHttp === null || !plainHttp.ok);

  const email = 'https@example.test';
  const password = 'https-password-15';
  assert.equal((await auth('sign-up/email', { email, password, name: 'HTTPS reader' }, undefined, origin)).status, 200);
  const link = await emailLink(email, '/api/auth/verify-email');
  assert.equal(new URL(link).origin, origin);
  assert.equal((await request(link)).status, 200);
  const login = await auth('sign-in/email', { email, password }, undefined, origin);
  assert.equal(login.status, 200);
  const setCookie = login.headers.getSetCookie().find((value) => value.startsWith('__Secure-gis.session_token='));
  for (const attribute of [/; Secure\b/i, /; HttpOnly\b/i, /; SameSite=Lax\b/i]) assert.match(setCookie, attribute);
  const cookie = cookieFrom(login);
  assert.equal((await document(`${origin}${collection}/items/central?f=json`, cookie)).id, 'central');
  const api = await document(`${origin}/features/openapi?f=json`, cookie);
  assert.equal(api.components.securitySchemes.session.name, '__Secure-gis.session_token');
});
