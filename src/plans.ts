import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeaturesConfig } from './config.js';
import { compose, prepareFeaturesStack, startFeaturesStack } from './features-stack.js';

export class CliError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface Plan {
  planId: string;
  baseVersion: string | null;
  config: FeaturesConfig;
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

async function readActive() {
  try {
    const { planId } = JSON.parse(await readFile(activeFile, 'utf8')) as { planId: string };
    return planId;
  } catch (error) {
    if (missing(error)) return null;
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
  const baseVersion = await readActive();
  const current = baseVersion ? (await readPlan(baseVersion)).config : null;
  const fingerprint = createHash('sha256').update(JSON.stringify({ baseVersion, config })).digest('hex');
  const planId = `plan-${fingerprint}`;
  await writeJson(join(planDirectory(planId), 'plan.json'), { planId, baseVersion, config });

  const previousUrl = current ? publicationUrl(current) : null;
  const newUrl = publicationUrl(config);
  const samePublication = current?.publicationId === config.publicationId;
  const changed = JSON.stringify(current) !== JSON.stringify(config);
  return {
    planId,
    baseVersion,
    added: samePublication ? [] : [config.publicationId],
    changed: samePublication && changed ? [config.publicationId] : [],
    removed: current && !samePublication ? [current.publicationId] : [],
    previousUrl,
    newUrl,
    services: changed ? ['pygeoapi', 'caddy'] : [],
  };
}

async function activatePlan(plan: Plan, current: Plan | null) {
  const directory = planDirectory(plan.planId);
  const previousDirectory = current && planDirectory(current.planId);
  try {
    await prepareFeaturesStack(plan.config, directory);
  } catch (error) {
    throw new CliError('APPLY_FAILED', 6, String(error), { planId: plan.planId });
  }

  try {
    if (current && previousDirectory) await compose(current.config, previousDirectory, 'stop', 'caddy');
    await startFeaturesStack(plan.config, directory);
    await writeJson(activeFile, { planId: plan.planId });
  } catch (error) {
    try {
      if (current && previousDirectory) {
        await compose(plan.config, directory, 'stop', 'caddy');
        await startFeaturesStack(current.config, previousDirectory);
      } else {
        await compose(plan.config, directory, 'down', '--volumes');
      }
    } catch (recoveryError) {
      await compose(plan.config, directory, 'stop', 'caddy').catch(() => {});
      throw new CliError('RECOVERY_INCOMPLETE', 7, `${error}\nRecovery: ${recoveryError}`, {
        planId: plan.planId,
        currentVersion: current?.planId ?? null,
      });
    }
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
    const active = await readActive();
    const data = { planId, currentVersion: active, url: publicationUrl(plan.config) };
    if (active === planId) return { code: 'NO_CHANGE', data };
    if (plan.baseVersion !== active) {
      throw new CliError('PLAN_STALE', 5, 'Create a new plan for the active configuration.', {
        planId, baseVersion: plan.baseVersion, currentVersion: active,
      });
    }
    const current = active ? await readPlan(active) : null;
    if (current && JSON.stringify(current.config) === JSON.stringify(plan.config)) {
      return { code: 'NO_CHANGE', data };
    }
    await activatePlan(plan, current);
    return { code: 'OK', data: { ...data, currentVersion: planId } };
  } finally {
    await rmdir(lock);
  }
}
