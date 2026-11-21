import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from './cli-result.js';
import { hasGeoJson, publicationEntries, usedFileSources, type FeaturesConfig } from './config.js';
import { closeGateway, compose, fileParts, openGateway } from './features-stack.js';
import { gatewayTlsFiles } from './gateway-tls.js';
import { readRestoreMarker, restoredGatewayClosed, restoreMarker, startRestoredGateway, withConfirmedConfiguration,
  writeRestoreMarker, writeStateJson, type RestoreMarker } from './plans.js';

const exec = promisify(execFile);
const payloadName = '.gis-backup-payload';
const workPrefix = '.gis-backup-work-';
const dumpName = 'accounts.dump';
const manifestName = 'manifest.json';
const restoreMarkerName = basename(restoreMarker);
const fullSnapshotId = /^[a-f0-9]{64}$/;
const versionId = /^plan-[a-f0-9]{64}$/;
const deploymentIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

interface Manifest {
  format: 1;
  deploymentId: string;
  stateDirectory: string;
  project: string;
  currentVersion: string;
  previousVersion: string | null;
  databaseCapturedAt: string;
  databaseHash: string;
  accessPolicy: string;
}

async function deploymentId(directory: string, initialize = false) {
  const path = join(directory, 'status', 'deployment-id.json');
  const id: unknown = await readFile(path, 'utf8').then(JSON.parse).catch(async (error: NodeJS.ErrnoException) => {
    if (!initialize || error.code !== 'ENOENT') throw error;
    const created = randomUUID();
    await writeStateJson(path, created);
    return created;
  });
  if (typeof id !== 'string' || !deploymentIdPattern.test(id)) incomplete('The deployment identity is invalid.');
  return id;
}

type BackupKind = 'daily' | 'pre-update';

function invalid(message: string): never {
  throw new CliError('INVALID_INPUT', 2, message);
}

function incomplete(message: string): never {
  throw new CliError('RECOVERY_INCOMPLETE', 7, message);
}

function verifyRepository() {
  const value = process.env.RESTIC_REPOSITORY;
  const url = value?.startsWith('rest:') ? URL.parse(value.slice(5)) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    invalid('Set RESTIC_REPOSITORY to the URL of an off-host REST repository over HTTPS without credentials.');
  }
}

function retentionDays() {
  const value = process.env.GIS_BACKUP_RETENTION_DAYS ?? '30';
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    invalid('GIS_BACKUP_RETENTION_DAYS must be a positive whole number.');
  }
  return Number(value);
}

async function restic(...args: string[]) {
  const executable = process.env.GIS_RESTIC_EXECUTABLE ?? 'restic';
  try {
    const { stdout } = await exec(executable, args, {
      windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, RESTIC_REPOSITORY_FILE: undefined },
    });
    return stdout;
  } catch (cause) {
    const code = cause instanceof Error && 'code' in cause ? cause.code : 'unknown';
    throw new CliError('FAILED', 1,
      `restic ${args[0]} failed (${code}). Check repository connectivity, credentials, restic availability and file access.`);
  }
}

async function docker(...args: string[]) {
  try {
    const { stdout } = await exec('docker', args, { windowsHide: true });
    return stdout.trim();
  } catch {
    throw new CliError('FAILED', 1, 'Docker could not inspect the backup or recovery project.');
  }
}

async function backupCompose(config: FeaturesConfig, revision: string, ...args: string[]) {
  try {
    return (await compose(config, revision, ...args)).trim();
  } catch {
    throw new CliError('FAILED', 1, 'Compose failed during backup or recovery. Inspect the selected project locally.');
  }
}

async function databaseFile(container: string, file: string, mode: 'dump' | 'restore') {
  const stream = await open(file, mode === 'dump' ? 'w' : 'r', 0o600);
  const args = mode === 'dump'
    ? ['pg_dump', '--format=custom', '--no-owner', '--no-acl', '-U', 'gis', '-d', 'gis']
    : ['pg_restore', '--clean', '--if-exists', '--create', '--no-owner', '--no-acl', '--exit-on-error',
      '-U', 'gis', '-d', 'postgres'];
  try {
    const task = spawn('docker', ['exec', ...(mode === 'restore' ? ['-i'] : []), container, ...args], {
      stdio: mode === 'dump' ? ['ignore', stream.fd, 'ignore'] : [stream.fd, 'ignore', 'ignore'],
      windowsHide: true,
    });
    const status = await new Promise<number | null>((done, fail) => {
      task.once('error', fail);
      task.once('close', done);
    });
    if (status !== 0) throw new CliError('FAILED', 1, `PostgreSQL ${mode} failed. Check the accounts database.`);
    if (mode === 'dump') await stream.sync();
  } finally {
    await stream.close();
  }
}

async function sha256(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function accessPolicy(config: FeaturesConfig) {
  const auth = config.auth;
  const modes = publicationEntries(config).map(([id, publication]) => [id, publication.source, publication.protocol, publication.access]);
  return createHash('sha256').update(JSON.stringify({
    administrators: [...new Set(auth?.administrator_emails ?? [])].sort(),
    operators: Object.entries(auth?.cli?.operators ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([operator, permissions]) => [operator, [...permissions].sort()]),
    signingSecret: auth && await sha256(auth.secret_file),
    adminCa: auth?.cli && await sha256(auth.cli.ca_file),
    modes: modes.sort(([a], [b]) => a!.localeCompare(b!)),
  })).digest('hex');
}

async function includePath(path: string, optional = false) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return [];
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    invalid('Backup inputs must be regular files or directories. Use the real paths of linked inputs.');
  }
  return [path];
}

async function referencedFiles(config: FeaturesConfig, revision: string, archivedTls: boolean) {
  const files: string[] = [];
  if (hasGeoJson(config)) files.push(config.sourcePath);
  const tls = await gatewayTlsFiles(config, revision, archivedTls);
  if (tls) files.push(...Object.values(tls.files));
  const auth = config.auth;
  if (auth) {
    files.push(auth.secret_file, auth.postgres_password_file);
    if (auth.mode === 'production' && auth.smtp.password_file) files.push(auth.smtp.password_file);
    if (auth.cli) files.push(auth.cli.cert_file, auth.cli.key_file, auth.cli.ca_file);
  }
  for (const provider of Object.values(config.providers ?? {})) {
    if (provider.postgis) files.push(provider.postgis.password_file);
  }
  const parts = usedFileSources(config).flatMap(([id, source]) => fileParts(id, source));
  return (await Promise.all([
    ...files.map((path) => includePath(path)),
    ...parts.map(({ path, optional }) => includePath(path, optional)),
  ])).flat();
}

function containsPath(root: string, path: string) {
  const child = relative(root, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isArchivedPayload(path: string) {
  const segments = path.split(/[\\/]/);
  return segments.at(-1) === payloadName && segments.at(-2)?.startsWith(workPrefix);
}

async function createBackup(kind: BackupKind, extraPaths: string[], days: number) {
  return withConfirmedConfiguration(async ({ directory, project, current, previous, history }) => {
    if (!current.config.auth) incomplete('A running platform PostgreSQL service is required for backup.');
    if (await readRestoreMarker()) incomplete('Finish recovery before backing up this deployment.');
    const revision = join(directory, 'plans', current.planId);
    const versions = previous ? [current, previous] : [current];
    const files = await Promise.all(versions.map((plan) =>
      referencedFiles(plan.config, join(directory, 'plans', plan.planId), plan.tlsFingerprint !== undefined)));
    const otherFiles = (await Promise.all(extraPaths.map((path) => includePath(resolve(path))))).flat();
    for (const path of otherFiles) {
      const real = await realpath(path);
      if (containsPath(real, directory) || containsPath(directory, real)) {
        invalid('Additional inputs must be outside the managed state directory and must not contain it.');
      }
      if (isArchivedPayload(real)) invalid('An additional input uses the reserved backup payload name.');
    }
    const identity = await deploymentId(directory, true);
    const paths = new Set([
      ...files.flat(),
      ...await includePath(join(directory, 'status'), true),
      ...await includePath(join(directory, 'active.json'), true),
      ...otherFiles,
    ]);
    for await (const plan of history) {
      paths.add(join(directory, 'plans', plan.planId));
      for (const tls of await includePath(join(directory, 'tls', plan.planId), true)) paths.add(tls);
    }
    const passwordFile = process.env.RESTIC_PASSWORD_FILE;
    if (!passwordFile) invalid('Set RESTIC_PASSWORD_FILE to the repository password file outside the backup inputs.');
    const keyPath = await realpath(passwordFile);
    if (containsPath(directory, keyPath)) invalid('The restic password file must be outside the managed state directory.');
    for (const path of paths) {
      if (containsPath(await realpath(path), keyPath)) invalid('The restic password file is inside the backup inputs.');
    }
    const scratch = await mkdtemp(join(directory, workPrefix));
    const payload = join(scratch, payloadName);
    const dump = join(payload, dumpName);
    const pathList = join(scratch, 'files');
    try {
      await mkdir(payload, { mode: 0o700 });
      const container = await backupCompose(current.config, revision, 'ps', '-q', 'postgres');
      if (!container) incomplete('The platform PostgreSQL service is unavailable.');
      const databaseCapturedAt = new Date().toISOString();
      await databaseFile(container, dump, 'dump');
      const manifest: Manifest = {
        format: 1, deploymentId: identity, stateDirectory: directory, project, currentVersion: current.planId,
        previousVersion: previous?.planId ?? null,
        databaseCapturedAt, databaseHash: await sha256(dump), accessPolicy: await accessPolicy(current.config),
      };
      await writeFile(join(payload, manifestName), JSON.stringify(manifest), { mode: 0o600, flush: true });
      await writeFile(pathList, [...paths, payload].join('\0') + '\0', { mode: 0o600 });
      const tag = `gis-platform-${project}`;
      const output = await restic('backup', '--json', '--tag', tag, '--files-from-raw', pathList);
      const snapshotId = output.trim().split(/\r?\n/).map((line) => JSON.parse(line))
        .find(({ message_type }) => message_type === 'summary')?.snapshot_id;
      if (typeof snapshotId !== 'string' || !fullSnapshotId.test(snapshotId)) {
        throw new CliError('FAILED', 1, 'restic did not report a complete snapshot.');
      }
      await restic('forget', '--tag', tag, '--group-by', '', '--keep-within', `${days}d`, '--prune');
      return { snapshotId, kind, retentionDays: days, databaseCapturedAt, currentVersion: current.planId, previousVersion: manifest.previousVersion };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

function snapshotPath(target: string, origin: string) {
  const windows = /^[a-z]:[\\/]/i.test(origin);
  const segments = origin.replace(windows ? /:[\\/]/ : /^\//, windows ? '/' : '').split(windows ? /[\\/]/ : '/');
  if (!(windows ? win32 : posix).isAbsolute(origin) || segments.includes('..')) {
    invalid('The backup contains an invalid source path.');
  }
  return join(target, ...segments);
}

async function manifestFrom(payload: string) {
  const manifest = JSON.parse(await readFile(join(payload, manifestName), 'utf8')) as Manifest;
  if (manifest.format !== 1 || !deploymentIdPattern.test(manifest.deploymentId) ||
      typeof manifest.project !== 'string' || !manifest.project || typeof manifest.stateDirectory !== 'string' ||
      !versionId.test(manifest.currentVersion) || (manifest.previousVersion !== null && !versionId.test(manifest.previousVersion)) ||
      typeof manifest.databaseCapturedAt !== 'string' || !Number.isFinite(Date.parse(manifest.databaseCapturedAt)) ||
      !fullSnapshotId.test(manifest.databaseHash) || !fullSnapshotId.test(manifest.accessPolicy) ||
      await sha256(join(payload, dumpName)) !== manifest.databaseHash) {
    incomplete('The backup accounts dump or its manifest is invalid.');
  }
  return manifest;
}

async function extractBackup(snapshotId: string, target: string) {
  if (!fullSnapshotId.test(snapshotId)) invalid('Use the full snapshot ID reported by restic.');
  const snapshots = JSON.parse(await restic('snapshots', '--json', snapshotId)) as { id: string; paths: string[] }[];
  const roots = snapshots.find(({ id }) => id === snapshotId)?.paths.filter(isArchivedPayload);
  if (roots?.length !== 1) invalid('The restic snapshot does not contain a GIS Platform backup.');
  await mkdir(target, { mode: 0o700 });
  await restic('restore', snapshotId, '--target', target, '--verify');
  const archivedPayload = snapshotPath(target, roots[0]!);
  const manifest = await manifestFrom(archivedPayload);
  const directory = snapshotPath(target, manifest.stateDirectory);
  if (dirname(dirname(archivedPayload)) !== directory || await deploymentId(directory) !== manifest.deploymentId) {
    invalid('The snapshot and state directories do not match.');
  }
  const payload = join(directory, payloadName);
  await rename(archivedPayload, payload);
  const revisions = join(directory, 'plans');
  for (const entry of await readdir(revisions, { withFileTypes: true })) {
    if (entry.isDirectory()) await writeFile(join(revisions, entry.name, 'closed'), '');
  }
  const status = join(directory, 'status');
  await mkdir(status, { recursive: true, mode: 0o700 });
  const active = join(status, 'active.json');
  if (!(await includePath(active, true)).length) {
    await rename(join(directory, 'active.json'), active);
  }
  await writeStateJson(join(status, restoreMarkerName), { snapshotId });
  return { snapshotId, directory, originalStateDirectory: manifest.stateDirectory, payload, databaseCapturedAt: manifest.databaseCapturedAt };
}

async function recoverBackup(authoritativePayload: string, attestation: '--verified-authority' | '--verified-no-changes') {
  return withConfirmedConfiguration(async ({ directory, project, current, previous }) => {
    if (!project.startsWith('gis-restore-') || process.env.GIS_PUBLIC_BIND !== '127.0.0.1' || !current.config.auth) {
      invalid('Use a dedicated gis-restore-* Compose project, an accounts database and GIS_PUBLIC_BIND=127.0.0.1.');
    }
    const marker = await readRestoreMarker();
    if (!marker || !fullSnapshotId.test(marker.snapshotId)) incomplete('Extract the backup with the recovery marker before starting recovery.');
    const payload = join(directory, payloadName);
    const backup = await manifestFrom(payload);
    if (backup.project === project || backup.stateDirectory !== directory || backup.deploymentId !== await deploymentId(directory) ||
        current.planId !== backup.currentVersion ||
        (previous?.planId ?? null) !== backup.previousVersion ||
        (marker.project !== undefined && marker.project !== project)) {
      incomplete('The recovery paths, Compose project or working versions do not match the extracted snapshot.');
    }
    const revision = join(directory, 'plans', current.planId);
    if (!marker.reconciled) await closeGateway(revision);
    const verified = marker.reconciled ?? await reconcile(marker, backup, current.config, revision, project, authoritativePayload, attestation);
    if (await restoredGatewayClosed(current.planId)) {
      if (await backupCompose(current.config, revision, 'ps', '-q', 'postgres') !== verified.postgres) {
        incomplete('The PostgreSQL container changed during recovery. Keep the gateway closed.');
      }
      try {
        await startRestoredGateway(current);
      } catch {
        incomplete('The reconciled database was restored, but the gateway did not pass the closed-start checks.');
      }
      await openGateway(revision);
    }
    await rm(restoreMarker);
    return { currentVersion: current.planId, previousVersion: backup.previousVersion, project,
      databaseCapturedAt: verified.databaseCapturedAt };
  });
}

async function reconcile(marker: RestoreMarker, backup: Manifest, config: FeaturesConfig, revision: string, project: string,
  authoritativePayload: string, attestation: '--verified-authority' | '--verified-no-changes') {
  const payload = join(backup.stateDirectory, payloadName);
  const authority = await manifestFrom(authoritativePayload);
  const authorityMarker = await readFile(join(dirname(authoritativePayload), 'status', restoreMarkerName), 'utf8')
    .then(JSON.parse) as RestoreMarker;
  if (!fullSnapshotId.test(authorityMarker.snapshotId) || authority.deploymentId !== backup.deploymentId ||
      authority.project !== backup.project || authority.stateDirectory !== backup.stateDirectory) {
    incomplete('The verified snapshot must come from the original deployment. Keep the gateway closed.');
  }
  const sameSnapshot = authorityMarker.snapshotId === marker.snapshotId && authority.databaseHash === backup.databaseHash;
  if (attestation === '--verified-no-changes' && !sameSnapshot) {
    incomplete('Use the exact recovered snapshot when independent records verify that no access changes followed the backup.');
  }
  if (attestation === '--verified-authority' &&
      (sameSnapshot || Date.parse(authority.databaseCapturedAt) <= Date.parse(backup.databaseCapturedAt))) {
    incomplete('A newer, verified accounts dump from the original deployment is required. Keep the gateway closed.');
  }
  if (authority.accessPolicy !== backup.accessPolicy || authority.accessPolicy !== await accessPolicy(config)) {
    incomplete('The backup and the current authorization settings differ. Use a backup with the verified current settings.');
  }
  if (!marker.project) {
    const label = `label=com.docker.compose.project=${project}`;
    if (await docker('ps', '-aq', '--filter', label) || await docker('volume', 'ls', '-q', '--filter', label)) {
      invalid('The recovery project already has containers or volumes. Choose a new project name.');
    }
    await writeRestoreMarker({ snapshotId: marker.snapshotId, project });
  } else {
    await backupCompose(config, revision, 'down', '--remove-orphans');
  }
  await backupCompose(config, revision, 'up', '-d', '--wait', '--wait-timeout', '65', 'postgres');
  const postgres = await backupCompose(config, revision, 'ps', '-q', 'postgres');
  await databaseFile(postgres, join(payload, dumpName), 'restore');
  if (!sameSnapshot) await databaseFile(postgres, join(authoritativePayload, dumpName), 'restore');
  const reconciled = { postgres, databaseCapturedAt: authority.databaseCapturedAt };
  await writeRestoreMarker({ snapshotId: marker.snapshotId, project, reconciled });
  return reconciled;
}

export async function runBackupCommand([command, first, second, ...rest]: string[]): Promise<Record<string, unknown>> {
  if (command === 'recover' && first && (second === '--verified-authority' || second === '--verified-no-changes') &&
      !rest.length && isAbsolute(first)) {
    return recoverBackup(first, second);
  }
  if (command === 'extract' && first && second && !rest.length) {
    verifyRepository();
    return extractBackup(first, resolve(second));
  }
  if (command === 'create' && (first === 'daily' || first === 'pre-update')) {
    verifyRepository();
    return createBackup(first, second ? [second, ...rest] : [], retentionDays());
  }
  return invalid('Usage: backup create <daily|pre-update> [file ...] | backup extract <snapshot-id> <new-directory> | backup recover <absolute-authoritative-payload> <verification-option>');
}
