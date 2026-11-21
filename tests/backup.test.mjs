import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { basename, dirname, join } from 'node:path';
import { json } from 'node:stream/consumers';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { auth, register, signIn } from './access-client.mjs';

function command(executable, args, env = process.env, exit = 0) {
  const result = spawnSync(executable, args, {
    env, encoding: 'utf8', timeout: 240_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, exit, result.stdout + result.stderr);
  return result.stdout.trim();
}

function cli(args, { env = process.env, code = 'OK', exit = 0 } = {}) {
  const output = command(process.execPath, ['dist/cli.js', ...args, '--json'], env, exit);
  const reply = JSON.parse(output);
  assert.equal(reply.code, code, output);
  return reply.data;
}

function backup(args, options) {
  return cli(['backup', ...args], options);
}

test('backup creation rejects local storage and invalid retention before touching the stack', () => {
  const env = { ...process.env, RESTIC_REPOSITORY: './local-backups' };
  const local = backup(['create', 'daily'], { env, code: 'INVALID_INPUT', exit: 2 });
  assert.match(local.message, /HTTPS/);
  const retention = backup(['create', 'pre-update'], {
    env: { ...env, RESTIC_REPOSITORY: 'rest:https://backup.example.test/gis', GIS_BACKUP_RETENTION_DAYS: '0' },
    code: 'INVALID_INPUT', exit: 2,
  });
  assert.match(retention.message, /positive whole number/);
});

const restServerImage = 'restic/rest-server:0.14.0@sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5';
const project = process.env.COMPOSE_PROJECT_NAME;
const state = process.env.GIS_STATE_DIR;
const fixture = process.env.GIS_TEST_RESULTS;
const config = process.env.GIS_TEST_CONFIG;
const privateItems = '/features/collections/private-places/items/central?f=json';
const publicItems = '/features/collections/places/items/central?f=json';
const registeredItems = '/features/collections/registered-places/items/central?f=json';
const password = 'backup-test-password';

const docker = (...args) => command('docker', args);
const compose = (name, ...args) => docker('compose', '-p', name, '-f', 'compose.yaml', '-f', 'compose.auth.yaml',
  '-f', 'compose.mailpit.yaml', ...args);

function freshRequest(path, headers = {}) {
  return new Promise((resolve, reject) => {
    get(new URL(path, process.env.GIS_TEST_PUBLIC_URL), {
      agent: false, headers, signal: AbortSignal.timeout(10_000),
    }, resolve).on('error', reject);
  });
}

async function check(path, status, headers = {}, readBody = false) {
  const response = await freshRequest(path, headers);
  assert.equal(response.statusCode, status, path);
  if (readBody) return json(response);
  response.resume();
}

const checkSession = (cookie) => check('/api/auth/get-session', 200, { Cookie: cookie }, true);

const bearer = ({ secret }) => ({ Authorization: `Bearer ${secret}` });

async function reader(name) {
  const email = `backup-${name}@example.test`;
  await register(email, password);
  const cookie = await signIn(email, password);
  cli(['access', 'grant', 'private-places', '--email', email]);
  const response = await auth('tokens/create', { name: 'Recovery check' }, cookie);
  assert.equal(response.status, 201);
  const token = await response.json();
  await check(privateItems, 200, bearer(token));
  return { email, cookie, token };
}

test('an encrypted off-host copy restores confirmed versions and only opens with current access', { skip: !fixture }, async () => {
  const recoveryProject = `gis-restore-${project}`;
  const noChangesProject = `${recoveryProject}-no-changes`;
  const restServer = `${project}-restic`;
  const restServerDir = join(fixture, 'backup-server');
  const storage = join(restServerDir, 'storage');
  mkdirSync(storage, { recursive: true });
  const serverCert = join(restServerDir, 'cert.pem');
  copyFileSync(join(fixture, 'https-cert.pem'), serverCert);
  copyFileSync(join(fixture, 'https-key.pem'), join(restServerDir, 'key.pem'));
  const resticPassword = join(fixture, 'backup-password');
  writeFileSync(resticPassword, randomBytes(48).toString('hex'));
  const env = {
    ...process.env, RESTIC_REPOSITORY: `rest:https://localhost:${process.env.GIS_TEST_BACKUP_SERVER_PORT}/platform/`,
    RESTIC_PASSWORD_FILE: resticPassword, RESTIC_CACERT: serverCert,
    RESTIC_CACHE_DIR: join(fixture, 'restic-cache'),
  };
  delete env.GIS_BACKUP_RETENTION_DAYS;
  const restic = (...args) => command(env.GIS_RESTIC_EXECUTABLE ?? 'restic', args, env);
  const snapshots = () => JSON.parse(restic('snapshots', '--json')).map(({ id }) => id);
  const recoveryEnv = { ...env, COMPOSE_PROJECT_NAME: recoveryProject };
  const tag = `gis-platform-${project}`;
  const sourceFiles = [config, ...['places.geojson', 'auth-secret', 'postgres-password', 'ca.pem', 'server.pem', 'server-key.pem']
    .map((file) => join(fixture, file))];
  const initial = cli(['status']).currentVersion;

  docker('run', '-d', '--rm', '--name', restServer,
    '-p', `127.0.0.1:${process.env.GIS_TEST_BACKUP_SERVER_PORT}:8000`,
    '--mount', `type=bind,src=${restServerDir},dst=/endpoint`, '--entrypoint', '/usr/bin/rest-server', restServerImage,
    '--path', '/endpoint/storage', '--no-auth', '--tls', '--tls-cert', '/endpoint/cert.pem', '--tls-key', '/endpoint/key.pem');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        restic('init');
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await setTimeout(250);
      }
    }
    const retentionFile = join(fixture, 'retention-fixture.txt');
    writeFileSync(retentionFile, 'retention fixture');
    const agedSnapshot = (days) => {
      const timestamp = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
      return restic('backup', '--json', '--tag', tag, '--time', timestamp, retentionFile)
        .split(/\r?\n/).map((line) => JSON.parse(line)).find(({ message_type }) => message_type === 'summary').snapshot_id;
    };
    const oldest = agedSnapshot(35);
    const middle = agedSnapshot(12);

    writeFileSync(config, readFileSync(config, 'utf8').replace('Closed places', 'Version two places'));
    const second = cli(['config', 'plan', config]).planId;
    cli(['config', 'apply', second]);
    for (const file of ['https-cert.pem', 'https-key.pem']) rmSync(join(fixture, file));

    // Create accounts serially to give each browser session and token an independent assertion.
    const grant = await reader('grant');
    const blocked = await reader('blocked');
    const revoked = await reader('token');
    const loggedOut = await reader('session');
    const allowed = await reader('unchanged');
    const daily = backup(['create', 'daily', config], { env });
    assert.equal(daily.retentionDays, 30);
    assert.equal(daily.previousVersion, initial);
    assert.equal(daily.currentVersion, second);
    assert.ok(snapshots().includes(middle) && !snapshots().includes(oldest));
    const signingSecret = readFileSync(join(fixture, 'auth-secret'));
    for (const entry of readdirSync(storage, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) assert.equal(readFileSync(join(entry.parentPath, entry.name)).includes(signingSecret), false);
    }
    const badPassword = join(fixture, 'wrong-password');
    writeFileSync(badPassword, 'wrong');
    const cannotRead = spawnSync(env.GIS_RESTIC_EXECUTABLE ?? 'restic', ['snapshots'], {
      env: { ...env, RESTIC_PASSWORD_FILE: badPassword }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(cannotRead.status, 12);

    cli(['access', 'revoke', 'private-places', '--email', grant.email]);
    cli(['users', 'block', '--email', blocked.email]);
    cli(['tokens', 'revoke', revoked.token.id, '--email', revoked.email]);
    assert.equal((await auth('sign-out', {}, loggedOut.cookie)).status, 200);
    await check(privateItems, 403, bearer(grant.token));
    await check(registeredItems, 403, bearer(blocked.token));
    await check(privateItems, 401, bearer(revoked.token));
    assert.equal(await checkSession(loggedOut.cookie), null);

    compose(project, 'stop', 'access');
    const authority = backup(['create', 'pre-update', config], {
      env: { ...env, GIS_BACKUP_RETENTION_DAYS: '7' },
    });
    assert.equal(authority.retentionDays, 7);
    assert.deepEqual(new Set(snapshots()), new Set([daily.snapshotId, authority.snapshotId]));

    const target = join(fixture, 'restored-backup');
    const restored = backup(['extract', daily.snapshotId, target], { env });
    const latest = backup(['extract', authority.snapshotId, join(fixture, 'verified-authority')], { env });
    assert.equal(restored.originalStateDirectory, state);
    for (const version of [initial, second]) {
      for (const file of ['Caddyfile', 'platform.yaml', 'openapi.json']) readFileSync(join(restored.directory, 'plans', version, file));
      for (const file of ['cert.pem', 'key.pem', 'ca.pem']) readFileSync(join(restored.directory, 'tls', version, file));
    }

    compose(project, 'down', '--remove-orphans');
    renameSync(state, `${state}-lost`);
    for (const file of sourceFiles) {
      renameSync(file, `${file}.lost`);
      const restoredFile = join(dirname(restored.directory), basename(file));
      copyFileSync(restoredFile, file);
    }
    cpSync(restored.directory, state, { recursive: true });
    const stale = backup(['recover', restored.payload, '--verified-authority'],
      { env: recoveryEnv, code: 'RECOVERY_INCOMPLETE', exit: 7 });
    assert.match(stale.message, /newer, verified/);
    const refused = cli(['config', 'apply', second], { env: recoveryEnv, code: 'RECOVERY_INCOMPLETE', exit: 7 });
    assert.match(refused.message, /verified current accounts database/);
    assert.equal(cli(['status'], { env: recoveryEnv, code: 'RECOVERY_INCOMPLETE', exit: 7 }).phase, 'restore');
    const mismatchedAttestation = backup(['recover', latest.payload, '--verified-no-changes'],
      { env: recoveryEnv, code: 'RECOVERY_INCOMPLETE', exit: 7 });
    assert.match(mismatchedAttestation.message, /exact recovered snapshot/);
    writeFileSync(join(fixture, 'auth-secret'), randomBytes(32).toString('hex'));
    const changedPolicy = backup(['recover', latest.payload, '--verified-authority'],
      { env: recoveryEnv, code: 'RECOVERY_INCOMPLETE', exit: 7 });
    assert.match(changedPolicy.message, /authorization settings differ/);
    writeFileSync(join(fixture, 'auth-secret'), signingSecret);
    await assert.rejects(freshRequest(privateItems));
    assert.equal(compose(recoveryProject, 'ps', '-aq'), '');

    const recovered = backup(['recover', latest.payload, '--verified-authority'], { env: recoveryEnv });
    assert.equal(recovered.currentVersion, second);
    assert.equal(recovered.previousVersion, initial);
    assert.equal(recovered.databaseCapturedAt, authority.databaseCapturedAt);
    const feature = await check(publicItems, 200, {}, true);
    assert.equal(feature.id, 'central');
    await check(privateItems, 200, bearer(allowed.token));
    await check(privateItems, 403, bearer(grant.token));
    await check(registeredItems, 403, bearer(blocked.token));
    await check(privateItems, 401, bearer(revoked.token));
    assert.equal(await checkSession(loggedOut.cookie), null);
    const rollback = cli(['config', 'plan', '--rollback-to', initial], { env: recoveryEnv });
    cli(['config', 'apply', rollback.planId], { env: recoveryEnv });
    await check(privateItems, 200, bearer(allowed.token));
    await check(privateItems, 403, bearer(grant.token));
    await check(registeredItems, 403, bearer(blocked.token));
    await check(privateItems, 401, bearer(revoked.token));
    assert.equal(await checkSession(loggedOut.cookie), null);
    const volumes = docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${recoveryProject}`)
      .split(/\r?\n/).sort();
    assert.deepEqual(volumes, ['accounts', 'caddy_config', 'caddy_data'].map((volume) => `${recoveryProject}_${volume}`));

    compose(recoveryProject, 'down', '--remove-orphans', '--volumes');
    renameSync(state, `${state}-first-recovery`);
    cpSync(latest.directory, state, { recursive: true });
    const unchanged = backup(['recover', latest.payload, '--verified-no-changes'], {
      env: { ...recoveryEnv, COMPOSE_PROJECT_NAME: noChangesProject },
    });
    assert.equal(unchanged.databaseCapturedAt, authority.databaseCapturedAt);
    await check(privateItems, 200, bearer(allowed.token));
    await check(privateItems, 401, bearer(revoked.token));
    assert.equal(await checkSession(loggedOut.cookie), null);
  } finally {
    compose(noChangesProject, 'down', '--remove-orphans', '--volumes');
    compose(recoveryProject, 'down', '--remove-orphans', '--volumes');
    docker('stop', restServer);
  }
});
