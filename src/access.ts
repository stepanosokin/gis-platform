import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import { mountAccountPages } from './account-pages.js';
import type { Publication } from './config.js';
import { featuresError, mountFeaturesMetadata, readManagedMetadata } from './features-metadata.js';
import { publicationAccess } from './publication-access.js';
import type { PublicationReader } from './publication-access.js';
import { prepareAccessStore, readPublicationReader } from './access-store.js';
import { startAdminServer } from './admin-server.js';
import { validTokenId, type AdminPermission } from './admin-command.js';
import { CliError } from './cli-result.js';
import { authorizePersonalToken, listPersonalTokens, preparePersonalTokens, publicationBearer, revokePersonalToken,
  tokenLifetime, tokenNameLimit } from './personal-tokens.js';

interface Settings {
  origin: string;
  production: boolean;
  smtp: { host: string; port: number; from: string; secure?: boolean; username?: string };
  publications: Record<string, Publication['access']>;
  administratorEmails?: string[];
  publicationTitles?: Record<string, string>;
  operators?: Record<string, AdminPermission[]>;
  version?: string;
  managedFeatures?: boolean;
}

const settings = JSON.parse(await readFile('/etc/gis/access.json', 'utf8')) as Settings;
const administratorEmails = new Set(settings.administratorEmails?.map((email) => email.toLowerCase()));
const publicationModes = new Map(Object.entries(settings.publications));
const hasProtectedPublications = [...publicationModes.values()].some((mode) => mode !== 'public');
const secureCookies = new URL(settings.origin).protocol === 'https:';
const readSecret = async (name: string) => (await readFile(`/run/secrets/${name}`, 'utf8')).replace(/\n+$/, '');
const pool = new Pool({ host: 'postgres', user: 'gis', database: 'gis',
  password: await readSecret('postgres_password'), connectionTimeoutMillis: 2000, query_timeout: 3000 });
pool.on('error', () => console.error('PostgreSQL connection is unavailable.'));

const smtp = nodemailer.createTransport({
  host: settings.smtp.host,
  port: settings.smtp.port,
  secure: settings.smtp.secure ?? settings.smtp.port === 465,
  requireTLS: settings.production,
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 5000,
  ...(settings.smtp.username && { auth: { user: settings.smtp.username, pass: await readSecret('smtp_password') } }),
});

function sendLink(to: string, subject: string, url: string) {
  return smtp.sendMail({ from: settings.smtp.from, to, subject, text: `${subject}\n\n${url}\n` });
}

const auth = betterAuth({
  appName: 'GIS Platform',
  baseURL: settings.origin,
  secret: (await readSecret('auth_secret')).trim(),
  database: pool,
  plugins: [apiKey({ defaultKeyLength: 48, requireName: true, maximumNameLength: tokenNameLimit, enableMetadata: true,
    startingCharactersConfig: { shouldStore: false },
    keyExpiration: { defaultExpiresIn: tokenLifetime, disableCustomExpiresTime: true },
    rateLimit: { enabled: false } })],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, token }) {
      const link = new URL('/account/reset-password', settings.origin);
      link.searchParams.set('token', token);
      await sendLink(user.email, 'Reset your GIS Platform password', link.href);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    async sendVerificationEmail({ user, url }) {
      const link = new URL(url);
      link.searchParams.set('callbackURL', '/account/verified');
      await sendLink(user.email, 'Confirm your GIS Platform email', link.href);
    },
  },
  user: {
    changeEmail: { enabled: false },
    additionalFields: { active: { type: 'boolean', required: true, defaultValue: true, input: false } },
  },
  session: { cookieCache: { enabled: false } },
  advanced: {
    cookiePrefix: 'gis',
    useSecureCookies: secureCookies,
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },
  rateLimit: { enabled: true },
  telemetry: { enabled: false },
  databaseHooks: {
    session: { create: { before: async (session, ctx) => {
      const user = await ctx?.context.internalAdapter.findUserById(session.userId);
      if (!user || !('active' in user) || user.active !== true) {
        throw new APIError('FORBIDDEN', { message: 'This account is inactive.' });
      }
    } } },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email' || ctx.path === '/update-user') {
        const name: unknown = ctx.body?.name;
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
          throw new APIError('BAD_REQUEST', { message: 'Enter a display name of 1 to 120 characters.' });
        }
        if (ctx.path === '/update-user' && Object.keys(ctx.body).some((field) => field !== 'name')) {
          throw new APIError('BAD_REQUEST', { message: 'Only the display name can be updated.' });
        }
        return { context: { body: { ...ctx.body, name: name.trim() } } };
      }
      if (ctx.path === '/change-password') {
        return { context: { body: { ...ctx.body, revokeOtherSessions: true } } };
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email' && ctx.path !== '/change-password') return;
      const result: unknown = ctx.context.returned;
      if (result && typeof result === 'object' && 'user' in result) {
        ctx.context.returned = { user: result.user };
      }
    }),
  },
  logger: { disabled: true },
});

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
await prepareAccessStore(pool);
await preparePersonalTokens(pool);
if (settings.operators) {
  await startAdminServer(pool, { operators: settings.operators, version: settings.version ?? 'unknown',
    publications: publicationModes, publicationTitles: settings.publicationTitles ?? {}, administratorEmails });
}

const app = express();
app.disable('x-powered-by');
app.enable('case sensitive routing');
app.enable('strict routing');
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
mountAccountPages(app);
const authHandler = toNodeHandler(auth);
async function readSession(req: Request) {
  return auth.api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableRefresh: true } });
}
function activeSession(session: Awaited<ReturnType<typeof readSession>>) {
  return session?.user.emailVerified && session.user.active ? session : null;
}

async function readPublicationIdentity(req: Request, publication?: readonly [string, Publication['access']]) {
  const secret = publicationBearer(req);
  if (secret !== undefined) {
    if (secret) return authorizePersonalToken(pool, secret, administratorEmails, publication ? [publication] : publicationModes);
    await pool.query('SELECT 1');
    return null;
  }
  const session = await readSession(req);
  if (session) {
    const reader = await readPublicationReader(pool, session.user.id, administratorEmails);
    return reader?.emailVerified ? { reader, userId: session.user.id, tokenId: undefined } : null;
  }
  // Without a session cookie Better Auth can return before checking PostgreSQL.
  await pool.query('SELECT 1');
  return null;
}

async function publicationReader(req: Request, res: Response, publication?: readonly [string, Publication['access']]):
  Promise<{ reader: PublicationReader | null; status: 200 | 401 | 403 }> {
  const requestId = req.get('X-GIS-Request-Id') ?? randomUUID();
  res.set('X-Request-Id', requestId);
  let identity: Awaited<ReturnType<typeof readPublicationIdentity>> = null;
  let status: ReturnType<typeof publicationAccess> | 503 = 503;
  try {
    identity = await readPublicationIdentity(req, publication);
    status = publication ? publicationAccess(publication[1], publication[0], identity?.reader ?? null) : 200;
    return { reader: identity?.reader ?? null, status };
  } catch (error) {
    if (publication ? publication[1] !== 'public' : hasProtectedPublications) throw error;
    status = 200;
    return { reader: null, status };
  } finally {
    const identified = identity?.reader.active || publication?.[1] !== 'public' ? identity : null;
    console.info(JSON.stringify({ event: 'publication.request', requestId, publicationId: publication?.[0],
      userId: identified?.userId, tokenId: identified?.tokenId, status }));
  }
}

async function requireActiveSession(req: Request, res: Response, next: NextFunction) {
  const session = await readSession(req);
  // A missing cookie can be rejected without I/O by Better Auth. Check the
  // dependency in that case so an outage still produces a 503.
  if (!session) await pool.query('SELECT 1');
  if (!session?.user.emailVerified) return featuresError(res, 401);
  if (!session.user.active) return featuresError(res, 403);
  res.locals.userId = session.user.id;
  res.locals.sessionId = session.session.id;
  next();
}

function requireAccountOrigin(req: Request, res: Response, next: NextFunction) {
  if (req.get('Origin') !== settings.origin) return featuresError(res, 403);
  next();
}

app.post(['/api/auth/update-user', '/api/auth/change-password'], requireActiveSession, authHandler);
app.post([
  '/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-out',
  '/api/auth/request-password-reset', '/api/auth/reset-password',
], authHandler);
app.get('/api/auth/verify-email', authHandler);
app.get('/api/auth/get-session', async (req, res) => {
  const session = activeSession(await readSession(req));
  res.json(session ? { user: session.user } : null);
});
app.get('/api/auth/tokens', requireActiveSession, async (_req, res) => {
  res.json({ tokens: await listPersonalTokens(pool, res.locals.userId) });
});
const accountJson = express.json({ limit: '4kb' });
app.post('/api/auth/tokens/create', requireAccountOrigin, requireActiveSession, accountJson, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > tokenNameLimit || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return res.status(400).json({ message: `Enter a token name of 1 to ${tokenNameLimit} characters.` });
  }
  try {
    const { id, key, createdAt, expiresAt } = await auth.api.createApiKey({
      body: { name, userId: res.locals.userId, metadata: { sessionId: res.locals.sessionId } },
    });
    res.status(201).json({ id, name, secret: key, createdAt, expiresAt });
  } catch (error) {
    const latest = await readSession(req);
    if (!latest?.user.emailVerified) return featuresError(res, 401);
    if (!latest.user.active) return featuresError(res, 403);
    throw error;
  }
});
app.post('/api/auth/tokens/revoke', requireAccountOrigin, requireActiveSession, accountJson, async (req, res) => {
  const id: unknown = req.body?.id;
  if (!validTokenId(id)) return res.status(400).json({ message: 'Enter a valid token ID.' });
  try {
    await revokePersonalToken(pool, id, res.locals.userId);
  } catch (error) {
    if (error instanceof CliError && error.code === 'NOT_FOUND') return res.status(404).json({ message: error.message });
    throw error;
  }
  res.sendStatus(204);
});
app.get('/internal/authorize/:publicationId', async (req, res) => {
  const { publicationId } = req.params;
  const mode = typeof publicationId === 'string' ? publicationModes.get(publicationId) : undefined;
  if (typeof publicationId !== 'string' || !mode) return res.sendStatus(404);
  const { status } = await publicationReader(req, res, [publicationId, mode]);
  if (status !== 200) return featuresError(res, status);
  res.sendStatus(204);
});
mountFeaturesMetadata(app, settings.publications, `${secureCookies ? '__Secure-' : ''}gis.session_token`,
  async (req, res) => (await publicationReader(req, res)).reader,
  settings.managedFeatures ? await readManagedMetadata() : undefined);
app.get('/internal/ready', async (_req, res) => {
  await pool.query('SELECT 1');
  res.sendStatus(204);
});
app.use((_req, res) => res.status(404).json({ code: 'NotFound' }));
app.use(((error, _req, res, _next) => {
  if (error?.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON.' });
  if (error?.type === 'entity.too.large') return res.status(413).json({ message: 'Request body is too large.' });
  console.error('Access request failed.', error instanceof Error ? error.name : 'Error');
  featuresError(res, 503);
}) satisfies express.ErrorRequestHandler);
app.listen(3000, '0.0.0.0');
