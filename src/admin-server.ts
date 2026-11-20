import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import express from 'express';
import type { Pool } from 'pg';
import { changeAccess, listUsers } from './access-store.js';
import { parseAdminCommand, requiredPermission, type AdminPermission } from './admin-command.js';
import { CliError } from './cli-result.js';
import type { Publication } from './config.js';

interface AdminSettings {
  operators: Record<string, AdminPermission[]>;
  version: string;
  publications: ReadonlyMap<string, Publication['access']>;
  publicationTitles: Record<string, string>;
  administratorEmails: ReadonlySet<string>;
}

export async function startAdminServer(pool: Pool, settings: AdminSettings) {
  const app = express();
  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  app.post('/command', (req, res, next) => {
    const socket = req.socket as TLSSocket;
    const actor = socket.authorized ? socket.getPeerCertificate()?.subject?.CN : undefined;
    if (req.get('Origin') || typeof actor !== 'string' || !Object.hasOwn(settings.operators, actor)) {
      return next(new CliError('FORBIDDEN', 4, 'This local account has no access to administrator commands.'));
    }
    res.locals.actor = actor;
    next();
  }, express.json({ limit: '4kb' }), async (req, res) => {
    if (!Array.isArray(req.body) || !req.body.every((arg: unknown) => typeof arg === 'string')) {
      throw new CliError('INVALID_INPUT', 2, 'Expected a CLI command.');
    }
    const command = parseAdminCommand(req.body);
    const actor: string = res.locals.actor;
    if (!settings.operators[actor]?.includes(requiredPermission(command))) {
      throw new CliError('FORBIDDEN', 4, 'This local account has no permission for this command.');
    }
    let result;
    if ('user' in command) {
      result = await changeAccess(pool, actor, command, settings.publications);
    } else if (command.operation === 'users list') {
      const users = await listUsers(pool, settings.publications, settings.publicationTitles, settings.administratorEmails);
      result = { code: 'OK', data: { users } };
    } else {
      const publicationId = 'publicationId' in command ? command.publicationId : undefined;
      if (publicationId && !settings.publications.has(publicationId)) {
        throw new CliError('NOT_FOUND', 3, 'Publication not found.');
      }
      await pool.query('SELECT 1');
      result = { code: 'OK', data: { currentVersion: settings.version, access: 'ready', publicationId } };
    }
    res.set('Cache-Control', 'no-store').json({ status: 'ok', ...result });
  });
  app.use((_req, _res, next) => next(new CliError('NOT_FOUND', 3, 'Administrator endpoint not found.')));
  app.use(((error, _req, res, _next) => {
    const failure = error instanceof CliError ? error :
      error instanceof SyntaxError || error?.type === 'entity.too.large'
        ? new CliError('INVALID_INPUT', 2, 'Invalid administrator request.')
        : new CliError('FAILED', 1, 'The administrator service is unavailable.');
    const status = { 1: 503, 2: 400, 3: 404, 4: 403 }[failure.exitCode] ?? 503;
    res.set('Cache-Control', 'no-store').status(status)
      .json({ status: 'error', code: failure.code, data: { message: failure.message } });
  }) satisfies express.ErrorRequestHandler);

  const [ca, cert, key] = await Promise.all(['cli_ca', 'cli_cert', 'cli_key']
    .map((name) => readFile(`/run/secrets/${name}`)));
  // The handler checks both the verified client certificate and the configured account.
  // Keep the handshake open for unauthenticated clients so the CLI can return FORBIDDEN.
  const server = createServer({ ca, cert, key, requestCert: true, rejectUnauthorized: false }, app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(3001, '0.0.0.0', resolve);
  });
}
