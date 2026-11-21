import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { parseFeaturesConfig, publicationsForProvider } from './config.js';
import { CliError } from './cli-result.js';
import { configurationStatus, createPlan } from './plans.js';
import { pullProviderImage } from './provider-images.js';

export async function planProviderCommand(command: string | undefined, args: string[]) {
  const [id, ...options] = args;
  const add = command === 'add' && options.length === 3;
  const update = command === 'update' && (options.length === 1 || options.length === 2);
  const remove = command === 'remove' && options.length === 1;
  if (!id || !/^[a-z][a-z0-9-]{0,62}$/.test(id) || !(add || update || remove)) {
    throw new CliError('INVALID_INPUT', 2, 'Usage: provider add <id> <image> <integration.yaml> <platform.yaml> | ' +
      'provider update <id> <platform.yaml> [image] | provider remove <id> <platform.yaml>');
  }
  const { currentVersion: baseVersion } = await configurationStatus();
  const filename = resolve(add ? options[2]! : options[0]!);
  const original = await readFile(filename, 'utf8').catch(() => {
    throw new CliError('INVALID_CONFIG', 2, 'The platform YAML could not be read.');
  });
  const config = checkedConfig(original, filename);
  const document = parseDocument(original);
  const path = ['providers', id];
  const existing = document.hasIn(path);
  if (add && existing) throw new CliError('INVALID_CONFIG', 2, 'The provider ID is already in use.');
  if (!add && !existing) throw new CliError('NOT_FOUND', 3, 'Provider not found.');
  let image: string | undefined;
  if (add) {
    const integration = await readFile(resolve(options[1]!), 'utf8').then((body) => parse(body) as unknown).catch(() => {
      throw new CliError('INVALID_CONFIG', 2, 'The provider integration YAML could not be read.');
    });
    if (!integration || typeof integration !== 'object' || Array.isArray(integration) ||
        Object.hasOwn(integration, 'image') || Object.hasOwn(integration, 'digest')) {
      throw new CliError('INVALID_CONFIG', 2, 'Expected a mapping with provider integration settings.');
    }
    image = options[0]!;
    document.setIn(path, document.createNode({ ...integration, image }));
  } else if (update) {
    const current = document.getIn([...path, 'image']);
    if (typeof current !== 'string') throw new CliError('INVALID_CONFIG', 2, 'This provider uses the built-in platform image.');
    image = options[1] ?? current;
    document.setIn([...path, 'image'], image);
    document.deleteIn([...path, 'digest']);
  } else {
    const linked = publicationsForProvider(config, id).map(([key]) => key);
    if (linked.length) throw new CliError('INVALID_CONFIG', 2, `Provider is used by: ${linked.join(', ')}.`, { publicationIds: linked });
    document.deleteIn(path);
  }
  checkedConfig(document.toString(), filename);
  if (image) document.setIn([...path, 'digest'], await pullProviderImage(image));
  const yaml = document.toString();
  return createPlan(checkedConfig(yaml, filename), yaml, { baseVersion }, {
    filename, original, originalConfig: config,
  });
}

function checkedConfig(yaml: string, filename: string) {
  try {
    return parseFeaturesConfig(yaml, dirname(filename));
  } catch (error) {
    throw new CliError('INVALID_CONFIG', 2, (error as Error).message);
  }
}
