import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const gateway = process.env.GIS_TEST_PUBLIC_URL;
const mailpit = process.env.GIS_TEST_MAILPIT;

export function request(path, options) {
  return fetch(new URL(path, gateway), { signal: AbortSignal.timeout(10_000), ...options });
}

export async function auth(endpoint, body, cookie, origin = gateway) {
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

export function cookieFrom(response) {
  const session = response.headers.getSetCookie().find((value) => /^(?:__Secure-)?gis\.session_token=/.test(value));
  assert.ok(session, 'expected a session cookie');
  return session.split(';')[0];
}

export async function emailLink(address, path) {
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

export async function register(email, password, name = 'Reader') {
  assert.equal((await auth('sign-up/email', { email, password, name })).status, 200);
  const link = await emailLink(email.toLowerCase(), '/api/auth/verify-email');
  assert.equal((await request(link)).status, 200);
}

export async function signIn(email, password) {
  const response = await auth('sign-in/email', { email, password });
  assert.equal(response.status, 200);
  return cookieFrom(response);
}

export async function session(cookie) {
  const response = await request('/api/auth/get-session', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return response.json();
}
