import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicationEntries, readFeaturesConfig } from './config.js';
import { configurationDoctor, configurationStatus, createPlan, planRollback } from './plans.js';
import type { ApplyReply } from './apply-worker.js';
import { CliError } from './cli-result.js';
import { runAdminCommand } from './admin-client.js';
import { parseAdminCommand } from './admin-command.js';
import { planProviderCommand } from './provider-command.js';
import { mapLibreFiles } from './maplibre-style.js';

const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
const commandArguments = arguments_.filter((value) => value !== '--json');
const [group, command, argument, ...extra] = commandArguments;

function success(code: string, data: Record<string, unknown>, message: string) {
  if (json) console.log(JSON.stringify({ status: 'ok', code, data }));
  else console.log(message);
}

async function main() {
  if (group === 'provider') {
    const plan = await planProviderCommand(command, commandArguments.slice(2));
    const result = await applyPlan(plan.planId);
    success(result.code, result.data, `Current version: ${result.data.currentVersion}`);
    return;
  }
  if (group === 'status' && !command) {
    const admin = process.env.GIS_ADMIN_PORT ? await runAdminCommand(commandArguments).catch((error: unknown) => {
      if (!(error instanceof CliError) || error.code !== 'FAILED') throw error;
      return error;
    }) : undefined;
    const local = await configurationStatus().catch((error: unknown) => {
      if (admin && !(admin instanceof Error) && error instanceof Error && 'code' in error && error.code === 'EACCES') return undefined;
      throw error;
    });
    if (admin instanceof Error && !local?.currentVersion && !local?.pendingPlanId) throw admin;
    const delegated = admin && !(admin instanceof Error) ? admin.data : undefined;
    const data = { ...delegated, ...(!delegated || local?.currentVersion || local?.pendingPlanId ? local : undefined) };
    const closedRoutes = Array.isArray(data.closedRoutes) ? data.closedRoutes : [];
    success('OK', data, `Current version: ${data.currentVersion ?? 'none'}\nPhase: ${data.phase ?? 'ready'}` +
      (closedRoutes.length ? `\nClosed routes: ${closedRoutes.join(', ')}` : ''));
    return;
  }
  if (group === 'doctor' && !process.env.GIS_ADMIN_PORT) {
    const parsed = parseAdminCommand(commandArguments);
    if (parsed.operation !== 'doctor') throw new CliError('INVALID_INPUT', 2, 'Invalid doctor command.');
    const result = { code: 'OK', data: await configurationDoctor(parsed.publicationId) };
    success(result.code, result.data, formatAdminResult(result));
    return;
  }
  if (group === 'status' || group === 'doctor' || group === 'users' || group === 'access' || group === 'tokens') {
    const result = await runAdminCommand(commandArguments);
    success(result.code, result.data, formatAdminResult(result));
    return;
  }
  const rollback = group === 'config' && command === 'plan' && argument === '--rollback-to' && extra.length === 1 && !!extra[0];
  if (group !== 'config' || !argument || (!rollback && (extra.length || argument === '--rollback-to')) ||
      (command !== 'validate' && command !== 'plan' && command !== 'apply')) {
    throw new CliError('INVALID_INPUT', 2,
      'Usage: config validate <file> | config plan <file> | config plan --rollback-to <version> | config apply <plan-id> [--json]');
  }

  if (command === 'apply') {
    const result = await applyPlan(argument);
    const action = result.code === 'OK' ? 'Applied' : 'Already active';
    success(result.code, result.data, `${action}: ${result.data.url ?? 'no publications'}\nCurrent version: ${result.data.currentVersion ?? 'none'}`);
    return;
  }

  const plan = rollback ? await planRollback(extra[0]!) : await planFile(command, argument);
  if (!plan) return;
  success('OK', plan, [
    plan.planId,
    `Base version: ${plan.baseVersion ?? 'none'}`,
    ...(plan.targetVersion ? [`Rollback target: ${plan.targetVersion}`] : []),
    `Added: ${plan.added.join(', ') || 'none'}`,
    `Changed: ${plan.changed.join(', ') || 'none'}`,
    `Removed: ${plan.removed.join(', ') || 'none'}`,
    `Public URL: ${plan.previousPublicUrl ?? '(none)'} → ${plan.publicUrl}`,
    `URL: ${plan.previousUrl ?? '(none)'} → ${plan.newUrl ?? '(none)'}`,
    ...plan.publications.map(({ publicationId, previousUrl, newUrl, previousAccess, newAccess, personalGrants }) =>
      `${publicationId}: ${previousUrl ?? '(none)'} → ${newUrl ?? '(none)'} | access: ${previousAccess ?? 'none'} → ${newAccess ?? 'none'} | grants: ${personalGrants}`),
    `Services: ${plan.services.join(', ') || 'none'}`,
    `Routes to close: ${plan.routesToClose.join(', ') || 'none'}`,
  ].join('\n'));
}

async function planFile(command: string, filename: string) {
  const { config, yaml } = await readFeaturesConfig(resolve(filename)).catch((error: unknown) => {
    throw new CliError('INVALID_CONFIG', 2, error instanceof Error ? error.message : String(error));
  });
  if (command === 'plan') return createPlan(config, yaml);
  await mapLibreFiles(config).catch((error: Error) => {
    throw new CliError('INVALID_CONFIG', 2, error.message);
  });
  const publicationIds = publicationEntries(config).map(([id]) => id);
  success('OK', { publicationId: config.publicationId, publicationIds }, `Valid configuration: ${publicationIds.join(', ') || 'no publications'}`);
}

async function applyPlan(planId: string) {
  // A disconnected CLI does not interrupt its independently running operation.
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./apply-worker.js', import.meta.url)), planId], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  const reply = await new Promise<ApplyReply>((resolve, reject) => {
    worker.once('message', (message: ApplyReply) => resolve(message));
    worker.once('error', reject);
    worker.once('exit', () => reject(new CliError('FAILED', 1, 'The configuration worker exited. Check status.')));
  });
  if (!reply.ok) throw new CliError(reply.code, reply.exitCode, reply.message, reply.data);
  return reply.result;
}

function formatAdminResult({ code, data }: Pick<Awaited<ReturnType<typeof runAdminCommand>>, 'code' | 'data'>) {
  if (group === 'users' && command === 'list') {
    const users = data.users as { email: string; name: string; registeredAt: string; status: string;
      publications: { id: string; anonymous: boolean }[] }[];
    return users.map((user) => {
      const publications = user.publications.map(({ id, anonymous }) => anonymous ? `${id} (anonymous)` : id);
      const displayName = user.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
      return [user.email, displayName, user.registeredAt, user.status, publications.join(', ') || 'none'].join('\t');
    }).join('\n') || 'No users.';
  }
  if (group === 'doctor' && data.publications && typeof data.gateway === 'string') {
    const publications = data.publications as Awaited<ReturnType<typeof configurationDoctor>>['publications'];
    const tls = data.tls as Awaited<ReturnType<typeof configurationDoctor>>['tls'];
    return [
      `Current version: ${data.currentVersion}`,
      `Gateway: ${data.gateway}`,
      ...(tls ? [`TLS: ${tls.state}${tls.expiresAt ? ` | expires: ${tls.expiresAt}` : ''}`] : []),
      ...publications.map(({ publicationId, instance, source }) => `${publicationId} | instance: ${instance} | source: ${source}`),
    ].join('\n');
  }
  if (typeof data.currentVersion === 'string') return `Access ready (version ${data.currentVersion}).`;
  if (group === 'tokens') {
    if (command === 'revoke') return code === 'NO_CHANGE' ? 'Token already revoked.' : 'Token revoked.';
    const tokens = data.tokens as { id: string; name: string; expiresAt: string; enabled: boolean }[];
    return tokens.map((token) => [token.id, token.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '),
      token.expiresAt, token.enabled ? (Date.parse(token.expiresAt) > Date.now() ? 'active' : 'expired') : 'revoked']
      .join('\t')).join('\n') || 'No tokens.';
  }
  return code === 'NO_CHANGE' ? 'No change.' : 'Access updated.';
}

try {
  await main();
} catch (error) {
  const failure = error instanceof CliError ? error : new CliError('FAILED', 1, String(error));
  if (json) {
    console.log(JSON.stringify({
      status: 'error',
      code: failure.code,
      data: { ...failure.data, message: failure.message },
    }));
  } else {
    console.error(failure.message);
  }
  process.exitCode = failure.exitCode;
}
