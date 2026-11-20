import { CliError } from './cli-result.js';

const permissions = {
  status: 'diagnostics',
  doctor: 'diagnostics',
  'users list': 'users-read',
  'users block': 'access-write',
  'users unblock': 'access-write',
  'access grant': 'access-write',
  'access revoke': 'access-write',
} as const;

export type AdminPermission = (typeof permissions)[keyof typeof permissions];

type UserSelector = { field: 'email' | 'id'; value: string };

export type AdminCommand =
  | { operation: 'status' | 'users list' }
  | { operation: 'doctor'; publicationId?: string }
  | { operation: 'users block' | 'users unblock'; user: UserSelector }
  | { operation: 'access grant' | 'access revoke'; publicationId: string; user: UserSelector };

export type AccessChange = Extract<AdminCommand, { user: UserSelector }>;

export function requiredPermission(command: AdminCommand) {
  return permissions[command.operation];
}

function validPublicationId(id: string | undefined): id is string {
  return id !== undefined && /^[a-z][a-z0-9-]{0,62}$/.test(id);
}

export function parseAdminCommand([group, ...args]: string[]): AdminCommand {
  const [action, first, second, third] = args;
  if (group === 'status' && args.length === 0) return { operation: 'status' };
  if (group === 'doctor') {
    if (args.length === 0) return { operation: 'doctor' };
    if (args.length === 2 && action === '--publication' && validPublicationId(first)) {
      return { operation: 'doctor', publicationId: first };
    }
  }
  if (group === 'users' && action === 'list' && args.length === 1) return { operation: 'users list' };
  const changeUser = group === 'users' && (action === 'block' || action === 'unblock') && args.length === 3;
  const changeGrant = group === 'access' && (action === 'grant' || action === 'revoke') &&
    args.length === 4 && validPublicationId(first);
  if (changeUser || changeGrant) {
    const [flag, value] = changeUser ? [first, second] : [second, third];
    if (value && value.length <= 254 && !/\s/.test(value)) {
      const field = flag === '--email' && /^[^@]+@[^@]+\.[^@]+$/.test(value) ? 'email' :
        flag === '--user-id' && !value.startsWith('-') ? 'id' : null;
      if (field) {
        const user: UserSelector = { field, value: field === 'email' ? value.toLowerCase() : value };
        if (changeUser) return { operation: action === 'block' ? 'users block' : 'users unblock', user };
        return { operation: action === 'grant' ? 'access grant' : 'access revoke', publicationId: first!, user };
      }
    }
  }
  throw new CliError('INVALID_INPUT', 2,
    'Usage: status | doctor [--publication <id>] | users list | users (block|unblock) (--email <email>|--user-id <id>) | access (grant|revoke) <publication-id> (--email <email>|--user-id <id>)');
}
