import type { Publication } from './config.js';

export interface PublicationReader {
  active: boolean;
  emailVerified: boolean;
  administrator: boolean;
  grants: ReadonlySet<string>;
}

export function publicationAccess(mode: Publication['access'], id: string, reader: PublicationReader | null) {
  if (mode === 'public') return 200;
  if (!reader?.emailVerified) return 401;
  if (!reader.active) return 403;
  return mode === 'registered' || reader.administrator || reader.grants.has(id) ? 200 : 403;
}
