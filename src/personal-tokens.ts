import { defaultKeyHasher } from '@better-auth/api-key';
import type { Request } from 'express';
import type { Pool, PoolClient } from 'pg';
import { readPublicationReader } from './access-store.js';
import { publicationAccess } from './publication-access.js';
import type { Publication } from './config.js';
import { CliError } from './cli-result.js';

export const tokenLifetime = 90 * 24 * 60 * 60;
export const tokenNameLimit = 120;

export function publicationBearer(req: Request) {
  const authorization = req.get('Authorization');
  if (authorization === undefined) return undefined;
  return /^Bearer ([A-Za-z0-9_-]{33,128})$/i.exec(authorization)?.[1] ?? null;
}

async function tokenTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function preparePersonalTokens(pool: Pool) {
  // Better Auth updates credentials and sessions in one PostgreSQL transaction.
  // Take the same user lock as publication admission and token creation.
  await pool.query(`
    CREATE OR REPLACE FUNCTION gis_revoke_tokens_on_password_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM id FROM "user" WHERE id = NEW."userId" FOR UPDATE;
      UPDATE apikey SET enabled = false, "updatedAt" = clock_timestamp()
        WHERE "referenceId" = NEW."userId" AND enabled;
      RETURN NEW;
    END;
    $$;
    CREATE OR REPLACE TRIGGER gis_password_change AFTER UPDATE OF password ON account
    FOR EACH ROW WHEN (NEW."providerId" = 'credential' AND OLD.password IS DISTINCT FROM NEW.password)
    EXECUTE FUNCTION gis_revoke_tokens_on_password_change();

    CREATE OR REPLACE FUNCTION gis_require_token_creation_session() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM id FROM "user" WHERE id = NEW."referenceId" AND active AND "emailVerified" FOR UPDATE;
      IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM session WHERE id = NEW.metadata::jsonb ->> 'sessionId'
          AND "userId" = NEW."referenceId" AND "expiresAt" > clock_timestamp()
      ) THEN
        RAISE EXCEPTION 'An active session is required to create a personal token' USING ERRCODE = '42501';
      END IF;
      NEW.metadata := NULL;
      RETURN NEW;
    END;
    $$;
    CREATE OR REPLACE TRIGGER gis_token_creation BEFORE INSERT ON apikey
    FOR EACH ROW EXECUTE FUNCTION gis_require_token_creation_session();
  `);
}

export async function authorizePersonalToken(pool: Pool, secret: string, administrators: ReadonlySet<string>,
  publications: Iterable<readonly [string, Publication['access']]>) {
  const { rows: [token] } = await pool.query<{ id: string; userId: string }>(
    `SELECT id, "referenceId" AS "userId" FROM apikey
     WHERE key = $1 AND enabled AND "expiresAt" > clock_timestamp()`, [await defaultKeyHasher(secret)]);
  if (!token) return null;

  return tokenTransaction(pool, async (client) => {
    // Serialize with grant changes and blocking before locking the token itself.
    await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [token.userId]);
    const current = await client.query(
      'SELECT id FROM apikey WHERE id = $1 AND enabled AND "expiresAt" > clock_timestamp() FOR UPDATE', [token.id]);
    if (!current.rowCount) return null;
    const reader = await readPublicationReader(client, token.userId, administrators);
    if (!reader?.emailVerified) return null;
    if (reader.active && [...publications].some(([id, mode]) => publicationAccess(mode, id, reader) === 200)) {
      const renewed = await client.query(`UPDATE apikey SET
        "expiresAt" = GREATEST("expiresAt", clock_timestamp() + $2 * interval '1 second'),
        "updatedAt" = clock_timestamp()
        WHERE id = $1 AND enabled AND "expiresAt" > clock_timestamp()`, [token.id, tokenLifetime]);
      if (!renewed.rowCount) return null;
    }
    return { reader, userId: token.userId, tokenId: token.id };
  });
}

export async function listPersonalTokens(pool: Pool, userId: string) {
  const { rows } = await pool.query<{ id: string; name: string; createdAt: Date; expiresAt: Date; enabled: boolean }>(
    `SELECT id, name, "createdAt", "expiresAt", enabled
     FROM apikey WHERE "referenceId" = $1 ORDER BY "createdAt", id`, [userId]);
  return rows;
}

export async function revokePersonalToken(pool: Pool, tokenId: string, userId: string, operator?: string) {
  return tokenTransaction(pool, async (client) => {
    const { rows: [token] } = await client.query<{ enabled: boolean }>(
      'SELECT enabled FROM apikey WHERE id = $1 AND "referenceId" = $2 FOR UPDATE', [tokenId, userId]);
    if (!token) throw new CliError('NOT_FOUND', 3, 'Token not found.');
    if (token.enabled) {
      await client.query('UPDATE apikey SET enabled = false, "updatedAt" = clock_timestamp() WHERE id = $1', [tokenId]);
      if (operator) {
        await client.query('INSERT INTO access_audit (actor, operation, user_id, token_id) VALUES ($1, $2, $3, $4)',
          [operator, 'tokens revoke', userId, tokenId]);
      }
    }
    return { code: token.enabled ? 'OK' : 'NO_CHANGE', data: { tokenId, userId } };
  });
}
