import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationEntries, serializeFeaturesConfig, type FeaturesConfig } from './config.js';
import { archiveLegacyOpenApi, closeGateway, compose, openGateway, prepareFeaturesStack, providerConfigurationChanged,
  resolveComposeProject, savedSourceFingerprint, sourceFingerprint, startFeaturesStack } from './features-stack.js';
import { CliError } from './cli-result.js';

interface Plan {
  planId: string;
  baseVersion: string | null;
  config: FeaturesConfig;
  yaml?: string;
  targetVersion?: string;
  attempt?: string;
  sourceHash?: string | null;
}

interface ActiveState {
  planId: string | null;
  previousVersion?: string | null;
  pendingPlanId?: string;
  phase?: 'preflight' | 'switch' | 'open' | 'recovery';
  closedRoutes?: string[];
  results?: Record<string, ApplyResult>;
}

interface ApplyResult {
  code: 'OK' | 'NO_CHANGE' | 'APPLY_FAILED' | 'RECOVERY_INCOMPLETE';
  message?: string;
}

const stateDirectory = resolve(process.env.GIS_STATE_DIR ??
  fileURLToPath(new URL('../.gis-platform', import.meta.url)));
const activeFile = join(stateDirectory, 'active.json');
const planDirectory = (planId: string) => join(stateDirectory, 'plans', planId);

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function writeJson(filename: string, value: unknown) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporaryFile = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporaryFile, filename);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

async function readActive(): Promise<ActiveState> {
  try {
    return JSON.parse(await readFile(activeFile, 'utf8')) as ActiveState;
  } catch (error) {
    if (missing(error)) return { planId: null };
    if (error instanceof SyntaxError) throw new CliError('FAILED', 1, 'The saved configuration state is unreadable.');
    throw error;
  }
}

async function readPlan(planId: string): Promise<Plan> {
  if (!/^plan-[0-9a-f]{64}$/.test(planId)) {
    throw new CliError('INVALID_INPUT', 2, 'Expected a plan ID returned by config plan.');
  }
  try {
    const plan = JSON.parse(await readFile(join(planDirectory(planId), 'plan.json'), 'utf8')) as Plan;
    if (plan.planId !== planId || fingerprint(plan) !== planId) {
      throw new CliError('INVALID_CONFIG', 2, 'The stored plan no longer matches its ID.', { planId });
    }
    return plan;
  } catch (error) {
    if (missing(error)) throw new CliError('NOT_FOUND', 3, 'Plan not found.', { planId });
    if (error instanceof SyntaxError) throw new CliError('INVALID_CONFIG', 2, 'The stored plan is unreadable.', { planId });
    throw error;
  }
}

function publicationUrl(config: FeaturesConfig) {
  return `${config.publicUrl}/collections/${config.publicationId}`;
}

export async function configurationStatus() {
  const state = await readActive();
  const data = {
    currentVersion: state.planId, previousVersion: state.previousVersion ?? null,
    phase: state.phase ?? (state.pendingPlanId ? 'switch' : 'ready'),
    pendingPlanId: state.pendingPlanId ?? null, closedRoutes: state.closedRoutes ?? [],
  };
  if (state.phase === 'recovery') throw new CliError('RECOVERY_INCOMPLETE', 7,
    `Configuration recovery is incomplete. Closed routes: ${data.closedRoutes.join(', ')}.`, data);
  return data;
}

export async function planRollback(version: string) {
  const state = await readActive();
  let confirmed = state.planId;
  while (confirmed) {
    const plan = await readPlan(confirmed);
    if (confirmed === version) return createPlan(plan.config, plan.yaml ?? serializeFeaturesConfig(plan.config), {
      targetVersion: confirmed, baseVersion: state.planId,
    });
    confirmed = plan.baseVersion;
  }
  throw new CliError('NOT_FOUND', 3, 'Confirmed configuration version not found.');
}

function fingerprint({ baseVersion, config, yaml, targetVersion, attempt, sourceHash }: Omit<Plan, 'planId'>) {
  return `plan-${createHash('sha256').update(JSON.stringify({ baseVersion, config, yaml, targetVersion, attempt, sourceHash })).digest('hex')}`;
}

export async function createPlan(config: FeaturesConfig, yaml?: string,
  versions?: { targetVersion: string; baseVersion: string | null }) {
  let { baseVersion, targetVersion } = versions ?? {};
  if (baseVersion === undefined) baseVersion = (await readActive()).planId;
  const currentPlan = baseVersion ? await readPlan(baseVersion) : null;
  const current = currentPlan?.config ?? null;
  const sourceHash = await sourceFingerprint(config.sourcePath);
  const changedSource = await sourceContentChanged(sourceHash, baseVersion);
  const snapshot = { baseVersion, config, yaml, targetVersion, attempt: randomUUID(), sourceHash };
  const planId = fingerprint(snapshot);
  await writeJson(join(planDirectory(planId), 'plan.json'), { ...snapshot, planId });

  const previousUrl = current ? publicationUrl(current) : null;
  const newUrl = publicationUrl(config);
  const changed = changedSource || JSON.stringify(current) !== JSON.stringify(config);
  const previous = new Map(current ? publicationEntries(current) : []);
  const next = new Map(publicationEntries(config));
  const platformChanged = changedSource || current?.publicUrl !== config.publicUrl || current?.sourcePath !== config.sourcePath ||
    JSON.stringify(current?.auth) !== JSON.stringify(config.auth) || JSON.stringify(current?.tls) !== JSON.stringify(config.tls);
  const outcomes = [...new Set([...previous.keys(), ...next.keys()])].map((id) => {
    const before = previous.get(id);
    const after = next.get(id);
    return {
      publicationId: id,
      previousUrl: before && current ? `${current.publicUrl}/collections/${id}` : null,
      newUrl: after ? `${config.publicUrl}/collections/${id}` : null,
      previousAccess: before?.access ?? null,
      newAccess: after?.access ?? null,
      personalGrants: !after ? 'inactive' : before ? 'preserve' : 'none',
    };
  });
  return {
    planId,
    baseVersion,
    targetVersion,
    added: [...next.keys()].filter((id) => !previous.has(id)),
    changed: [...next].filter(([id, publication]) => previous.has(id) &&
      (platformChanged || JSON.stringify(previous.get(id)) !== JSON.stringify(publication))).map(([id]) => id),
    removed: [...previous.keys()].filter((id) => !next.has(id)),
    previousUrl,
    newUrl,
    publications: outcomes,
    routesToClose: changed ? affectedRoutes(config, current) : [],
    services: changed ? ['caddy', ...(changedSource || !currentPlan?.yaml ||
      providerConfigurationChanged(config, current) ? ['pygeoapi'] : []),
      ...(config.auth || current?.auth ? ['access'] : []),
      ...(current?.auth?.postgres_password_file !== config.auth?.postgres_password_file ? ['postgres'] : []),
      ...(mailPort(current) !== mailPort(config) ? ['mailpit'] : [])] : [],
  };
}

async function sourceContentChanged(sourceHash: string | null | undefined, baseVersion: string | null) {
  if (!sourceHash || !baseVersion) return false;
  const previousHash = await savedSourceFingerprint(planDirectory(baseVersion));
  return previousHash !== null && previousHash !== sourceHash;
}

function mailPort(config: FeaturesConfig | null) {
  return config?.auth?.mode === 'development' ? config.auth.mailpit_port ?? 8025 : null;
}

function revision(plan: Plan) {
  return { config: plan.config, directory: planDirectory(plan.planId) };
}

function settled(state: ActiveState, planId: string, outcome: ApplyResult): ActiveState {
  return {
    planId: state.planId, previousVersion: state.previousVersion,
    results: { ...state.results, [planId]: outcome },
  };
}

async function secureGateway(rev: ReturnType<typeof revision>, legacy = false) {
  const { config, directory } = rev;
  if (legacy) {
    await compose(config, directory, 'stop', 'caddy');
  } else {
    await closeGateway(directory).catch(() => compose(config, directory, 'stop', 'caddy'));
  }
}

async function restoreStack(state: ActiveState, candidate: Plan, current: Plan | null, message: string) {
  const { directory } = revision(candidate);
  try {
    await secureGateway(revision(candidate), !candidate.yaml);
    if (current) {
      const previous = revision(current);
      if (!current.yaml) await prepareFeaturesStack(previous, { useArchivedOpenApi: true });
      await closeGateway(previous.directory);
      await startFeaturesStack(current.config, previous.directory);
      await openGateway(previous.directory);
    } else {
      await compose(candidate.config, directory, 'down', '--remove-orphans');
    }
    const outcome = state.results?.[candidate.planId] ?? { code: 'APPLY_FAILED', message };
    await writeJson(activeFile, settled(state, candidate.planId, outcome));
  } catch {
    await secureGateway(revision(candidate)).catch(() => {});
    if (current) await secureGateway(revision(current), !current.yaml).catch(() => {});
    const outcome = { code: 'RECOVERY_INCOMPLETE', message: 'The previous configuration could not be restored.' } as const;
    await writeJson(activeFile, { ...state, phase: 'recovery', results: {
      ...state.results, [candidate.planId]: outcome,
    } });
  }
}

function affectedRoutes(candidate: FeaturesConfig, current: FeaturesConfig | null) {
  const versions = current ? [current, candidate] : [candidate];
  return [...new Set(versions.flatMap((config) => [
    config.publicUrl,
    `${config.publicUrl}/collections`,
    `${config.publicUrl}/openapi`,
    ...publicationEntries(config).map(([id]) => `${config.publicUrl}/collections/${id}`),
    ...(config.auth ? ['/account', '/api/auth'].map((path) => new URL(path, config.publicUrl).href) : []),
  ]))];
}

async function openConfirmedVersion(state: ActiveState, candidate: Plan) {
  const confirmed: ActiveState = {
    ...state, phase: 'open', planId: candidate.planId, previousVersion: state.planId,
  };
  await writeJson(activeFile, confirmed);
  await openGateway(revision(candidate).directory);
  await writeJson(activeFile, settled(confirmed, candidate.planId, { code: 'OK' }));
}

async function activatePlan(state: ActiveState, plan: Plan, current: Plan | null) {
  const candidate = revision(plan);
  await writeJson(activeFile, { ...state, pendingPlanId: plan.planId, phase: 'preflight' });
  try {
    if (current && !current.yaml) {
      const previous = revision(current);
      await writeFile(join(previous.directory, 'platform.yaml'), serializeFeaturesConfig(current.config), { mode: 0o600 });
      await readFile(join(previous.directory, 'openapi.json')).catch(() => archiveLegacyOpenApi(previous));
    }
    await prepareFeaturesStack(candidate, { previous: current ? revision(current) : undefined, sourceHash: plan.sourceHash });
    if (plan.yaml !== undefined) await writeFile(join(candidate.directory, 'platform.yaml'), plan.yaml, { mode: 0o600 });
  } catch {
    await writeJson(activeFile, settled(state, plan.planId, {
      code: 'APPLY_FAILED', message: 'Preflight failed while checking the source, TLS, native configuration or OpenAPI.',
    }));
    return;
  }
  const pending: ActiveState = {
    ...state, pendingPlanId: plan.planId, phase: 'switch', closedRoutes: affectedRoutes(plan.config, current?.config ?? null),
  };
  await writeJson(activeFile, pending);
  try {
    await closeGateway(candidate.directory);
    if (current) await secureGateway(revision(current), !current.yaml);
    await startFeaturesStack(plan.config, candidate.directory);
    await openConfirmedVersion(pending, plan);
  } catch {
    await restoreStack(pending, plan, current, 'The candidate failed verification and the previous configuration was restored.');
  }
}

async function applicationLock(scope: string) {
  const lock = createServer((connection) => connection.destroy());
  const key = createHash('sha256').update(scope).digest('hex');
  // The OS releases the lock when the worker exits, including after a forced stop.
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\gis-platform-${key}` : `\0gis-platform-${key}`;
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(path, () => resolve());
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EADDRINUSE', 'EACCES'].includes(String(error.code))) {
      throw new CliError('APPLY_IN_PROGRESS', 5, 'An apply operation is already in progress.');
    }
    throw error;
  }
  return lock;
}

function resultFor(state: ActiveState, plan: Plan) {
  const data = {
    planId: plan.planId, currentVersion: state.planId, url: publicationUrl(plan.config),
  };
  const result = state.results?.[plan.planId] ?? { code: 'NO_CHANGE' };
  if (result.code === 'APPLY_FAILED' || result.code === 'RECOVERY_INCOMPLETE') {
    throw new CliError(result.code, result.code === 'APPLY_FAILED' ? 6 : 7, result.message!,
      { ...data, ...(result.code === 'RECOVERY_INCOMPLETE' && { closedRoutes: state.closedRoutes ?? [] }) });
  }
  return { code: result.code, data };
}

export async function applyPlan(planId: string) {
  const plan = await readPlan(planId);
  const directory = await realpath(stateDirectory);
  const stateLock = await applicationLock(`state:${process.platform === 'win32' ? directory.toLowerCase() : directory}`);
  let projectLock: Awaited<ReturnType<typeof applicationLock>> | undefined;
  try {
    projectLock = await applicationLock(`compose:${await resolveComposeProject()}`);
    let state = await readActive();
    if (state.results?.[planId]) return resultFor(state, plan);
    if (state.pendingPlanId) {
      const candidate = await readPlan(state.pendingPlanId);
      const previousId = state.phase === 'open' ? state.previousVersion : state.planId;
      const previous = previousId ? await readPlan(previousId) : null;
      if (state.phase === 'preflight') {
        await writeJson(activeFile, settled(state, candidate.planId, {
          code: 'APPLY_FAILED', message: 'The preflight check was interrupted.',
        }));
      } else {
        if (state.phase === 'open') {
          state = { ...state, planId: previous?.planId ?? null, previousVersion: previous?.baseVersion ?? null };
        }
        await restoreStack(state, candidate, previous, 'The interrupted application was rolled back.');
      }
      state = await readActive();
      if (state.results?.[planId]) return resultFor(state, plan);
      if (state.phase === 'recovery') return resultFor(state, candidate);
    }
    const current = state.planId ? await readPlan(state.planId) : null;
    if (state.planId === planId) return resultFor(state, plan);
    if (plan.baseVersion !== state.planId) {
      throw new CliError('PLAN_STALE', 5, 'Create a new plan for the active configuration.', {
        planId, baseVersion: plan.baseVersion, currentVersion: state.planId,
      });
    }
    if (current && JSON.stringify(current.config) === JSON.stringify(plan.config) &&
        !await sourceContentChanged(plan.sourceHash, current.planId)) {
      const sourceChangedAfterPlanning = await sourceContentChanged(await sourceFingerprint(plan.config.sourcePath), current.planId);
      const outcome = sourceChangedAfterPlanning
        ? { code: 'APPLY_FAILED', message: 'The GeoJSON source changed after planning. Create a new plan.' } as const
        : { code: 'NO_CHANGE' } as const;
      await writeJson(activeFile, settled(state, planId, outcome));
    } else {
      await activatePlan(state, plan, current);
    }
    return resultFor(await readActive(), plan);
  } finally {
    projectLock?.close();
    stateLock.close();
  }
}
