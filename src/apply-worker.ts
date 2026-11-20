import { applyPlan } from './plans.js';
import { CliError } from './cli-result.js';

export type ApplyReply =
  | { ok: true; result: Awaited<ReturnType<typeof applyPlan>> }
  | { ok: false; code: string; exitCode: number; message: string; data: Record<string, unknown> };

if (process.send) {
  let reply: ApplyReply;
  try {
    reply = { ok: true, result: await applyPlan(process.argv[2] ?? '') };
  } catch (error) {
    const failure = error instanceof CliError
      ? error : new CliError('FAILED', 1, 'Cannot complete the configuration operation. Check status.');
    reply = { ok: false, code: failure.code, exitCode: failure.exitCode, message: failure.message, data: failure.data };
  }
  if (process.connected) process.send(reply, undefined, {}, () => {
    if (process.connected) process.disconnect();
  });
}
