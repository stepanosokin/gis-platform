import type { Pool } from 'pg';
import type { AccessChange } from './admin-command.js';
import { CliError } from './cli-result.js';
import type { Publication } from './config.js';
import { publicationAccess } from './publication-access.js';

interface AccessUser {
  id: string;
  email: string;
  active: boolean;
  emailVerified: boolean;
  grants: string[];
}

const grantsForUser = `ARRAY(SELECT publication_id FROM publication_grant WHERE user_id = u.id) AS grants`;

export async function prepareAccessStore(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS publication_grant (
      user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      publication_id text NOT NULL,
      PRIMARY KEY (user_id, publication_id)
    );
    CREATE TABLE IF NOT EXISTS access_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor text NOT NULL,
      operation text NOT NULL,
      user_id text NOT NULL,
      publication_id text
    );
  `);
}

function reader(user: AccessUser, administrators: ReadonlySet<string>) {
  return {
    active: user.active, emailVerified: user.emailVerified,
    administrator: administrators.has(user.email), grants: new Set(user.grants),
  };
}

export async function readPublicationReader(pool: Pool, userId: string, administrators: ReadonlySet<string>) {
  const { rows: [user] } = await pool.query<AccessUser>(
    `SELECT id, email, active, "emailVerified", ${grantsForUser} FROM "user" AS u WHERE id = $1`, [userId]);
  return user ? reader(user, administrators) : null;
}

export async function listUsers(pool: Pool, publications: ReadonlyMap<string, Publication['access']>,
  titles: Record<string, string>, administrators: ReadonlySet<string>) {
  const { rows } = await pool.query<AccessUser & { name: string; createdAt: Date }>(
    `SELECT id, email, name, "createdAt", active, "emailVerified", ${grantsForUser} FROM "user" AS u ORDER BY email, id`);
  return rows.map((user) => {
    const subject = reader(user, administrators);
    return {
      id: user.id, email: user.email, name: user.name, registeredAt: user.createdAt,
      status: !user.active ? 'blocked' : user.emailVerified ? 'active' : 'unverified',
      publications: [...publications].flatMap(([id, access]) =>
        publicationAccess(access, id, subject) === 200
          ? [{ id, title: titles[id] ?? id, access, anonymous: !(user.emailVerified && user.active) }]
          : []),
    };
  });
}

export async function changeAccess(pool: Pool, actor: string, command: AccessChange,
  publications: ReadonlyMap<string, Publication['access']>) {
  const publicationId = 'publicationId' in command ? command.publicationId : undefined;
  if (publicationId) {
    const mode = publications.get(publicationId);
    if (!mode) throw new CliError('NOT_FOUND', 3, 'Publication not found.');
    if (mode !== 'private' && command.operation === 'access grant') {
      throw new CliError('INVALID_INPUT', 2, 'Personal grants apply to private publications.');
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const column = command.user.field === 'email' ? 'email' : 'id';
    const { rows: [user] } = await client.query<{ id: string }>(
      `SELECT id FROM "user" WHERE ${column} = $1 FOR UPDATE`, [command.user.value]);
    if (!user) throw new CliError('NOT_FOUND', 3, 'User not found.');

    const statement = {
      'access grant': 'INSERT INTO publication_grant (user_id, publication_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      'access revoke': 'DELETE FROM publication_grant WHERE user_id = $1 AND publication_id = $2',
      'users block': 'UPDATE "user" SET active = false, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $1 AND active',
      'users unblock': 'UPDATE "user" SET active = true, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $1 AND NOT active',
    }[command.operation];
    const changed = (await client.query(statement, publicationId ? [user.id, publicationId] : [user.id])).rowCount === 1;
    if (changed) {
      await client.query('INSERT INTO access_audit (actor, operation, user_id, publication_id) VALUES ($1, $2, $3, $4)',
        [actor, command.operation, user.id, publicationId ?? null]);
    }
    await client.query('COMMIT');
    if (changed) {
      console.info(JSON.stringify({ event: 'access.change', actor, operation: command.operation, userId: user.id, publicationId }));
    }
    return { code: changed ? 'OK' : 'NO_CHANGE', data: { userId: user.id, publicationId } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
