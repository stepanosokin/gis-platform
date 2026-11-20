import { readFile } from 'node:fs/promises';
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
import { featuresError, mountFeaturesMetadata } from './features-metadata.js';

interface Settings {
  origin: string;
  production: boolean;
  smtp: { host: string; port: number; from: string; secure?: boolean; username?: string };
  publications: Record<string, Publication['access']>;
}

const settings = JSON.parse(await readFile('/etc/gis/access.json', 'utf8')) as Settings;
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

async function requireActiveSession(req: Request, res: Response, next: NextFunction) {
  const session = await readSession(req);
  // A missing cookie can be rejected without I/O by Better Auth. Check the
  // dependency in that case so an outage still produces a 503.
  if (!session) await pool.query('SELECT 1');
  if (!session?.user.emailVerified) return featuresError(res, 401);
  if (!session.user.active) return featuresError(res, 403);
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
app.get('/internal/authorize', requireActiveSession, (_req, res) => {
  res.sendStatus(204);
});
mountFeaturesMetadata(app, settings.publications, `${secureCookies ? '__Secure-' : ''}gis.session_token`,
  async (req) => activeSession(await readSession(req)) !== null);
app.get('/internal/ready', async (_req, res) => {
  await pool.query('SELECT 1');
  res.sendStatus(204);
});
app.use((_req, res) => res.status(404).json({ code: 'NotFound' }));
app.use(((error, _req, res, _next) => {
  console.error('Access request failed.', error instanceof Error ? error.name : 'Error');
  featuresError(res, 503);
}) satisfies express.ErrorRequestHandler);
app.listen(3000, '0.0.0.0');
