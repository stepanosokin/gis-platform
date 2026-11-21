import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { json } from 'node:stream/consumers';
import { parseAdminCommand } from './admin-command.js';
import { CliError } from './cli-result.js';

interface AdminResponse {
  status: 'ok' | 'error';
  code: string;
  data: Record<string, unknown>;
}

export async function runAdminCommand(args: string[]) {
  parseAdminCommand(args);
  const port = Number(process.env.GIS_ADMIN_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError('INVALID_INPUT', 2, 'Set GIS_ADMIN_PORT to the local administrator port.');
  }
  const caFile = process.env.GIS_ADMIN_CA_FILE;
  const certFile = process.env.GIS_ADMIN_CERT_FILE;
  const keyFile = process.env.GIS_ADMIN_KEY_FILE;
  if (!caFile || !certFile || !keyFile) {
    throw new CliError('FORBIDDEN', 4, 'The local administrator credentials are not configured.');
  }
  const [ca, cert, key] = await Promise.all([caFile, certFile, keyFile].map((file) => readFile(file)))
    .catch(() => { throw new CliError('FORBIDDEN', 4, 'Cannot read the local administrator credentials.'); });

  const payload = JSON.stringify(args);
  const result = await new Promise<AdminResponse>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path: '/command', method: 'POST',
      signal: AbortSignal.timeout(8000), ca, cert, key, rejectUnauthorized: true,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      json(res).then((value) => resolve(value as AdminResponse), reject);
    });
    req.on('error', reject);
    req.end(payload);
  }).catch(() => { throw new CliError('FAILED', 1, 'Cannot connect to the local administrator service.'); });

  if (result.status === 'error') {
    const exitCode = { INVALID_INPUT: 2, NOT_FOUND: 3, FORBIDDEN: 4, APPLY_IN_PROGRESS: 5,
      RECOVERY_INCOMPLETE: 7 }[result.code] ?? 1;
    const { message, ...data } = result.data;
    throw new CliError(result.code, exitCode, String(message), data);
  }
  return result;
}
