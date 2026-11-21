import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function caddyPorts(files, overrides = {}) {
  const env = { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1' };
  for (const variable of ['COMPOSE_ENV_FILES', 'GIS_PUBLIC_BIND', 'GIS_PUBLIC_PORT', 'GIS_HTTP_REDIRECT_PORT', 'GIS_CADDY_PORT']) {
    delete env[variable];
  }
  const result = spawnSync('docker', ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'], {
    encoding: 'utf8', windowsHide: true, env: { ...env, ...overrides },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).services.caddy.ports.map(({ host_ip, published, target }) => ({ host_ip, published, target }));
}

test('Caddy publishes the standard public ports without a loopback override', () => {
  assert.deepEqual(caddyPorts(['compose.yaml']), [{ host_ip: undefined, published: '80', target: 80 }]);
  const tls = caddyPorts(['compose.yaml', 'compose.tls.yaml'], { GIS_CADDY_PORT: '443', GIS_PUBLIC_PORT: '443' });
  assert.deepEqual(tls.sort((first, second) => first.target - second.target), [
    { host_ip: undefined, published: '80', target: 80 },
    { host_ip: undefined, published: '443', target: 443 },
  ]);
});
