import { resolve } from 'node:path';
import { publicationEntries, readFeaturesConfig } from './config.js';
import { applyPlan, CliError, createPlan } from './plans.js';

const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
const [group, command, argument, ...extra] = arguments_.filter((value) => value !== '--json');

function success(code: string, data: Record<string, unknown>, message: string) {
  if (json) console.log(JSON.stringify({ status: 'ok', code, data }));
  else console.log(message);
}

async function main() {
  if (group !== 'config' || !argument || extra.length ||
      (command !== 'validate' && command !== 'plan' && command !== 'apply')) {
    throw new CliError('INVALID_INPUT', 2,
      'Usage: config validate <file> | config plan <file> | config apply <plan-id> [--json]');
  }

  if (command === 'apply') {
    const result = await applyPlan(argument);
    const action = result.code === 'OK' ? 'Applied' : 'Already active';
    success(result.code, result.data, `${action}: ${result.data.url}`);
    return;
  }

  const config = await readFeaturesConfig(resolve(argument)).catch((error: unknown) => {
    throw new CliError('INVALID_CONFIG', 2, error instanceof Error ? error.message : String(error));
  });
  if (command === 'validate') {
    const publicationIds = publicationEntries(config).map(([id]) => id);
    success('OK', { publicationId: config.publicationId, publicationIds }, `Valid configuration: ${publicationIds.join(', ')}`);
    return;
  }

  const plan = await createPlan(config);
  success('OK', plan, [
    plan.planId,
    `Added: ${plan.added.join(', ') || 'none'}`,
    `Changed: ${plan.changed.join(', ') || 'none'}`,
    `Removed: ${plan.removed.join(', ') || 'none'}`,
    `URL: ${plan.previousUrl ?? '(none)'} → ${plan.newUrl}`,
    `Services: ${plan.services.join(', ') || 'none'}`,
  ].join('\n'));
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
