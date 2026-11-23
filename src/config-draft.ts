import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { parseFeaturesConfig } from './config.js';
import { CliError } from './cli-result.js';

export const draftFile = (filename: string) => `${filename}.draft.yaml`;
export const textDigest = (text: string) => createHash('sha256').update(text).digest('hex');

export async function readDraftText(filename: string) {
  return readFile(draftFile(filename), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

export async function workingYaml(filename: string) {
  return readFile(filename, 'utf8').catch(() => {
    throw new CliError('INVALID_CONFIG', 2, 'The working platform YAML could not be read.');
  });
}

export function checkedYaml(yaml: string, filename: string) {
  try {
    return parseFeaturesConfig(yaml, dirname(filename));
  } catch (error) {
    throw new CliError('INVALID_CONFIG', 2, (error as Error).message);
  }
}

export function draftYaml(text: string, original: string, version: string | null) {
  const header = /^# GIS Platform draft ([0-9a-f]{64}) (none|plan-[0-9a-f]{64})\r?\n/.exec(text);
  if (!header) throw new CliError('INVALID_CONFIG', 2, 'The draft header is invalid.');
  if (header[1] !== textDigest(original) || header[2] !== (version ?? 'none')) {
    throw new CliError('PLAN_STALE', 5, 'The working YAML or active version changed. Review the draft and use draft rebase.');
  }
  return text.slice(header[0].length);
}

async function settingsFile(filename: string) {
  try {
    const settings: unknown = parse(await readFile(filename, 'utf8'));
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      return settings as Record<string, unknown>;
    }
  } catch {
    // Settings can contain operator-local configuration values.
  }
  throw new CliError('INVALID_CONFIG', 2, 'The settings file must be a readable YAML mapping.');
}

const mappingFor = { postgis: 'postgis_connections', provider: 'providers', publication: 'publications' } as const;

export async function editDraft(command: string, filename: string, args: string[], version: string | null) {
  const original = await workingYaml(filename);
  const saved = await readDraftText(filename);
  let next: string;
  if (command === 'rebase') {
    if (saved === undefined) throw new CliError('NOT_FOUND', 3, 'There is no draft to rebase.');
    next = await readFile(args[0]!, 'utf8').catch(() => {
      throw new CliError('INVALID_CONFIG', 2, 'The reviewed candidate YAML could not be read.');
    });
    next = next.replace(/^# GIS Platform draft [^\r\n]+\r?\n/, '');
  } else {
    const current = saved === undefined ? original : draftYaml(saved, original, version);
    checkedYaml(current, filename);
    const document = parseDocument(current);
    const [id, parameter, integration] = args as [string, string, string];
    if (command === 'auth') {
      if (document.has('auth')) throw new CliError('INVALID_CONFIG', 2, 'Registration and sign-in are already configured.');
      document.set('auth', document.createNode(await settingsFile(id)));
    } else if (command === 'access') {
      if (!document.hasIn(['publications', id])) throw new CliError('NOT_FOUND', 3, 'Publication not found.');
      document.setIn(['publications', id, 'access'], parameter);
    } else {
      const path = [mappingFor[command as keyof typeof mappingFor], id];
      if (document.hasIn(path)) throw new CliError('INVALID_CONFIG', 2, `The ID is already in use: ${id}.`);
      const settings = await settingsFile(command === 'provider' ? integration : parameter);
      if (command === 'provider') {
        if (Object.hasOwn(settings, 'image') || Object.hasOwn(settings, 'digest')) {
          throw new CliError('INVALID_CONFIG', 2, 'Pass the image as an argument and omit image and digest from the integration YAML.');
        }
        document.setIn(path, document.createNode({ ...settings, image: parameter }));
      } else if (command === 'publication' && Object.hasOwn(settings, 'source_settings')) {
        const { source_settings: sourceSettings, ...publication } = settings;
        if (typeof publication.source !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(publication.source)) {
          throw new CliError('INVALID_CONFIG', 2, 'Expected a valid source ID in the publication settings.');
        }
        if (document.hasIn(['sources', publication.source])) {
          throw new CliError('INVALID_CONFIG', 2, 'The source ID already exists. Omit source_settings to use the existing source.');
        }
        document.setIn(['sources', publication.source], document.createNode(sourceSettings));
        document.setIn(path, document.createNode(publication));
      } else {
        document.setIn(path, document.createNode(settings));
      }
    }
    next = document.toString();
  }
  checkedYaml(next, filename);
  const target = draftFile(filename);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `# GIS Platform draft ${textDigest(original)} ${version ?? 'none'}\n${next}`,
      { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { draftFile: target, baseVersion: version };
}
