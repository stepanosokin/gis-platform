import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationEntries, type FeaturesConfig } from './config.js';
import { compose, prepareFeaturesStack, startFeaturesStack } from './features-stack.js';
import { CliError } from './cli-result.js';

interface Plan {
  planId: string;
  baseVersion: string | null;
  config: FeaturesConfig;
}

interface ActiveState {
  planId: string | null;
  pendingPlanId?: string;
}

const stateDirectory = resolve(process.env.GIS_STATE_DIR ??
  fileURLToPath(new URL('../.gis-platform', import.meta.url)));
const activeFile = join(stateDirectory, 'active.json');
const planDirectory = (planId: string) => join(stateDirectory, 'plans', planId);

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function writeJson(filename: string, value: unknown) {
  await mkdir(dirname(filename), { recursive: true });
  const temporaryFile = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, JSON.stringify(value), { flag: 'wx' });
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
    throw error;
  }
}

async function readPlan(planId: string): Promise<Plan> {
  if (!/^plan-[0-9a-f]{64}$/.test(planId)) {
    throw new CliError('INVALID_INPUT', 2, 'Expected a plan ID returned by config plan.');
  }
  try {
    return JSON.parse(await readFile(join(planDirectory(planId), 'plan.json'), 'utf8')) as Plan;
  } catch (error) {
    if (missing(error)) throw new CliError('NOT_FOUND', 3, 'Plan not found.', { planId });
    throw error;
  }
}

function publicationUrl(config: FeaturesConfig) {
  return `${config.publicUrl}/collections/${config.publicationId}`;
}

export async function createPlan(config: FeaturesConfig) {
  const { planId: baseVersion } = await readActive();
  const current = baseVersion ? (await readPlan(baseVersion)).config : null;
  const fingerprint = createHash('sha256').update(JSON.stringify({ baseVersion, config })).digest('hex');
  const planId = `plan-${fingerprint}`;
  await writeJson(join(planDirectory(planId), 'plan.json'), { planId, baseVersion, config });

  const previousUrl = current ? publicationUrl(current) : null;
  const newUrl = publicationUrl(config);
  const changed = JSON.stringify(current) !== JSON.stringify(config);
  const previous = new Map(current ? publicationEntries(current) : []);
  const next = new Map(publicationEntries(config));
  const platformChanged = current?.publicUrl !== config.publicUrl || current?.sourcePath !== config.sourcePath ||
    JSON.stringify(current?.auth) !== JSON.stringify(config.auth) || JSON.stringify(current?.tls) !== JSON.stringify(config.tls);
  return {
    planId,
    baseVersion,
    added: [...next.keys()].filter((id) => !previous.has(id)),
    changed: [...next].filter(([id, publication]) => previous.has(id) &&
      (platformChanged || JSON.stringify(previous.get(id)) !== JSON.stringify(publication))).map(([id]) => id),
    removed: [...previous.keys()].filter((id) => !next.has(id)),
    previousUrl,
    newUrl,
    services: changed ? ['pygeoapi', 'caddy', ...(config.auth || current?.auth ? ['access', 'postgres'] : []),
      ...(config.auth?.mode === 'development' || current?.auth?.mode === 'development' ? ['mailpit'] : [])] : [],
  };
}

async function restoreStack(candidate: Plan, current: Plan | null) {
  const directory = planDirectory(candidate.planId);
  try {
    if (current) {
      await compose(candidate.config, directory, 'stop', 'caddy');
      await startFeaturesStack(current.config, planDirectory(current.planId));
    } else {
      await compose(candidate.config, directory, 'down', '--remove-orphans');
    }
    await writeJson(activeFile, { planId: current?.planId ?? null });
  } catch (error) {
    await compose(candidate.config, directory, 'stop', 'caddy').catch(() => {});
    throw new CliError('RECOVERY_INCOMPLETE', 7, String(error), {
      planId: candidate.planId,
      currentVersion: current?.planId ?? null,
    });
  }
}

async function activatePlan(plan: Plan, current: Plan | null) {
  const directory = planDirectory(plan.planId);
  try {
    await prepareFeaturesStack(plan.config, directory);
    await writeJson(activeFile, { planId: current?.planId ?? null, pendingPlanId: plan.planId });
  } catch (error) {
    throw new CliError('APPLY_FAILED', 6, String(error), { planId: plan.planId });
  }

  try {
    if (current) await compose(current.config, planDirectory(current.planId), 'stop', 'caddy');
    await startFeaturesStack(plan.config, directory);
    await writeJson(activeFile, { planId: plan.planId });
  } catch (error) {
    await restoreStack(plan, current);
    throw new CliError('APPLY_FAILED', 6, String(error), { planId: plan.planId });
  }
}

export async function applyPlan(planId: string) {
  const plan = await readPlan(planId);
  const lock = join(stateDirectory, 'apply.lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new CliError('APPLY_IN_PROGRESS', 5, 'An apply operation is already in progress.');
    }
    throw error;
  }

  try {
    const { planId: active, pendingPlanId } = await readActive();
    const current = active ? await readPlan(active) : null;
    if (pendingPlanId) await restoreStack(await readPlan(pendingPlanId), current);
    const data = { planId, currentVersion: active, url: publicationUrl(plan.config) };
    if (active === planId) return { code: 'NO_CHANGE', data };
    if (plan.baseVersion !== active) {
      throw new CliError('PLAN_STALE', 5, 'Create a new plan for the active configuration.', {
        planId, baseVersion: plan.baseVersion, currentVersion: active,
      });
    }
    if (current && JSON.stringify(current.config) === JSON.stringify(plan.config)) {
      return { code: 'NO_CHANGE', data };
    }
    await activatePlan(plan, current);
    return { code: 'OK', data: { ...data, currentVersion: planId } };
  } finally {
    await rmdir(lock);
  }
}
