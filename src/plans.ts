import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtInProviderId, hasGeoJson, hasProtocolMetadata, managedProviderRuns, needsMetadataService, postgisSource, publicationEntries, publicationUrl, providerRoutes,
  fileSource, serializeFeaturesConfig, usedFileSources, vectorFile, type FeaturesConfig, type Publication } from './config.js';
import { pinProviderImages } from './provider-images.js';
import { archiveLegacyOpenApi, closeGateway, compose, diagnoseStack, featuresStackRunning, openGateway, prepareFeaturesStack, providerConfigurationChanged,
  publicationGrantRemoval, resolveComposeProject, savedSourceFingerprint, savedFileFingerprints, sourceFingerprint,
  startFeaturesStack, fileFingerprints, FeaturesPreflightError, verifyLegacyGatewayTls } from './features-stack.js';
import { CliError } from './cli-result.js';
import { mapLibreFiles, mapLibreHashes, writeMapLibreFiles } from './maplibre-style.js';
import { statusSnapshot, type ActiveState, type ApplyResult } from './configuration-state.js';
import { archiveGatewayTls, gatewayTlsFiles, gatewayTlsFingerprint, GatewayTlsError } from './gateway-tls.js';

interface Plan {
  planId: string;
  baseVersion: string | null;
  config: FeaturesConfig;
  yaml?: string;
  targetVersion?: string;
  attempt?: string;
  sourceHash?: string | null;
  // Keep the persisted field name for plans created before raster file support.
  vectorHashes?: Record<string, string | null>;
  maplibreHashes?: Record<string, string>;
  tlsFingerprint?: string | null;
  edit?: { filename: string; before: string };
}

const stateDirectory = resolve(process.env.GIS_STATE_DIR ??
  fileURLToPath(new URL('../.gis-platform', import.meta.url)));
const legacyActiveFile = join(stateDirectory, 'active.json');
const activeFile = join(stateDirectory, 'status', 'active.json');
const planDirectory = (planId: string) => join(stateDirectory, 'plans', planId);

function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function writeStateJson(filename: string, value: unknown) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporaryFile = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporaryFile, filename);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

async function readActive(): Promise<ActiveState> {
  try {
    const contents = await readFile(activeFile, 'utf8').catch((error) => {
      if (!missing(error)) throw error;
      return readFile(legacyActiveFile, 'utf8').catch((legacyError) => {
        if (!missing(legacyError)) throw legacyError;
        // An apply can move the legacy file between these two reads.
        return readFile(activeFile, 'utf8');
      });
    });
    return JSON.parse(contents) as ActiveState;
  } catch (error) {
    if (missing(error)) return { planId: null };
    if (error instanceof SyntaxError) throw new CliError('FAILED', 1, 'The saved configuration state is unreadable.');
    throw error;
  }
}

async function readPlan(planId: string): Promise<Plan> {
  if (!/^plan-[0-9a-f]{64}$/.test(planId)) {
    throw new CliError('INVALID_INPUT', 2, 'Expected a plan ID returned by config plan.');
  }
  try {
    const plan = JSON.parse(await readFile(join(planDirectory(planId), 'plan.json'), 'utf8')) as Plan;
    if (plan.planId !== planId || fingerprint(plan) !== planId) {
      throw new CliError('INVALID_CONFIG', 2, 'The stored plan no longer matches its ID.', { planId });
    }
    return plan;
  } catch (error) {
    if (missing(error)) throw new CliError('NOT_FOUND', 3, 'Plan not found.', { planId });
    if (error instanceof SyntaxError) throw new CliError('INVALID_CONFIG', 2, 'The stored plan is unreadable.', { planId });
    throw error;
  }
}

function firstPublicationUrl(config: FeaturesConfig) {
  return config.publicationId === null ? null : publicationUrl(config, config.publicationId, config.publication);
}

async function writeActive(state: ActiveState) {
  await writeStateJson(activeFile, state);
}

async function migrateActiveFile() {
  try {
    await stat(activeFile);
  } catch (error) {
    if (!missing(error)) throw error;
    await mkdir(dirname(activeFile), { recursive: true, mode: 0o700 });
    await rename(legacyActiveFile, activeFile).catch((moveError) => {
      if (!missing(moveError)) throw moveError;
    });
  }
}

export async function configurationStatus() {
  const state = await readActive();
  const { recoveryIncomplete, ...data } = statusSnapshot(state);
  if (await restoreRequired(state.planId)) {
    const plan = state.planId ? await readPlan(state.planId) : null;
    throw new CliError('RECOVERY_INCOMPLETE', 7, 'Restore the verified current accounts database before opening the gateway.', {
      ...data, phase: 'restore', closedRoutes: plan ? publicationEntries(plan.config).map(([id, publication]) =>
        publicationUrl(plan.config, id, publication)) : [],
    });
  }
  if (recoveryIncomplete) throw new CliError('RECOVERY_INCOMPLETE', 7,
    `Configuration recovery is incomplete. Closed routes: ${data.closedRoutes.join(', ')}.`, data);
  return data;
}

export async function configurationDoctor(publicationId?: string) {
  const { planId } = await readActive();
  if (!planId) throw new CliError('NOT_FOUND', 3, 'There is no confirmed configuration.');
  const current = await readPlan(planId);
  if (publicationId && !publicationEntries(current.config).some(([id]) => id === publicationId)) {
    throw new CliError('NOT_FOUND', 3, 'Publication not found.');
  }
  return { currentVersion: planId, publicationId, ...await diagnoseStack(revision(current), publicationId) };
}

export async function planRollback(version: string) {
  const state = await readActive();
  for await (const plan of confirmedHistory(state.planId ? await readPlan(state.planId) : null)) {
    if (plan.planId === version) return createPlan(plan.config, plan.yaml ?? serializeFeaturesConfig(plan.config), {
      targetVersion: version, baseVersion: state.planId,
    });
  }
  throw new CliError('NOT_FOUND', 3, 'Confirmed configuration version not found.');
}

async function* confirmedHistory(current: Plan | null) {
  for (let version = current; version; version = version.baseVersion ? await readPlan(version.baseVersion) : null) {
    yield version;
  }
}

function postgisLocation(config: FeaturesConfig, publication: Publication) {
  const source = postgisSource(config, publication.source);
  const connection = config.providers?.[publication.tile_provider ?? publication.provider]?.postgis;
  return source && connection
    ? [connection.host, connection.port, connection.database, source.schema, source.relation]
    : undefined;
}

async function checkPublicationIdentities(config: FeaturesConfig, current: Plan | null) {
  const unverified = new Map(publicationEntries(config));
  if (!unverified.size) return;
  const retired = new Set<string>();
  const reject = (id: string) => {
    throw new CliError('INVALID_CONFIG', 2, `Publication ID '${id}' is reserved for its original source and protocol. Use a new ID.`);
  };
  for await (const version of confirmedHistory(current)) {
    for (const [id, previous] of publicationEntries(version.config)) {
      const candidate = unverified.get(id);
      if (!candidate) continue;
      const before = postgisLocation(version.config, previous);
      const after = postgisLocation(config, candidate);
      const beforeFile = fileSource(version.config, previous.source);
      const afterFile = fileSource(config, candidate.source);
      const sameIdentity = previous.source === candidate.source && previous.protocol === candidate.protocol &&
        JSON.stringify(before) === JSON.stringify(after) &&
        beforeFile?.type === afterFile?.type &&
        vectorFile(version.config, previous.source)?.layer === vectorFile(config, candidate.source)?.layer;
      if (version === current) {
        if (!sameIdentity) reject(id);
      } else {
        retired.add(id);
        if (!sameIdentity || beforeFile?.path !== afterFile?.path ||
            (!before && !beforeFile && version.config.sourcePath !== config.sourcePath)) continue;
      }
      unverified.delete(id);
    }
    if (!unverified.size) return;
  }
  for (const id of retired) if (unverified.has(id)) reject(id);
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprint({ baseVersion, config, yaml, targetVersion, attempt, sourceHash, vectorHashes, edit, maplibreHashes,
  tlsFingerprint }: Omit<Plan, 'planId'>) {
  return `plan-${digest(JSON.stringify({ baseVersion, config, yaml, targetVersion, attempt, sourceHash, vectorHashes, edit,
    maplibreHashes, tlsFingerprint }))}`;
}

async function tlsSource(config: FeaturesConfig, target: Plan | null) {
  return target
    ? (await gatewayTlsFiles(config, planDirectory(target.planId), target.tlsFingerprint !== undefined))?.files
    : config.tls;
}

export async function createPlan(config: FeaturesConfig, yaml?: string,
  versions?: { targetVersion?: string; baseVersion: string | null }, editFile?: {
    filename: string; original: string; originalConfig: FeaturesConfig;
  }) {
  let { baseVersion, targetVersion } = versions ?? {};
  if (baseVersion === undefined) baseVersion = (await readActive()).planId;
  const currentPlan = baseVersion ? await readPlan(baseVersion) : null;
  await checkPublicationIdentities(config, currentPlan);
  const current = currentPlan?.config ?? null;
  if (current && editFile) {
    const before = editFile.originalConfig;
    for (const [id, provider] of Object.entries(before.providers ?? {})) {
      const active = current.providers?.[id];
      if (provider.image && !provider.digest && active?.image === provider.image) provider.digest = active.digest;
    }
    if (JSON.stringify(before) !== JSON.stringify(current)) {
      throw new CliError('INVALID_CONFIG', 2, 'Apply the pending platform YAML changes before managing providers.');
    }
  }
  await pinProviderImages(config, current);
  const sourceHash = hasGeoJson(config) ? await sourceFingerprint(config.sourcePath) : null;
  const changedSource = await sourceContentChanged(sourceHash, baseVersion);
  const fileHashes = config.vectorFiles || config.rasterFiles || config.tileArchives || config.dggsSources
    ? await fileFingerprints(config) : undefined;
  const changedFiles = await fileContentChanges(fileHashes, baseVersion);
  const edit = editFile && { filename: editFile.filename, before: digest(editFile.original) };
  const mapFiles = await mapLibreFiles(config, targetVersion && planDirectory(targetVersion)).catch((error: Error) => {
    throw new CliError('INVALID_CONFIG', 2, error.message);
  });
  const maplibreHashes = mapLibreHashes(mapFiles);
  const target = targetVersion ? await readPlan(targetVersion) : null;
  const tlsFingerprint = await gatewayTlsFingerprint(await tlsSource(config, target));
  if (target && target.tlsFingerprint !== undefined && tlsFingerprint !== target.tlsFingerprint) {
    throw new CliError('INVALID_CONFIG', 2, 'The archived TLS files do not match the selected version.');
  }
  if (target && JSON.stringify(maplibreHashes) !== JSON.stringify(target.maplibreHashes)) {
    throw new CliError('INVALID_CONFIG', 2, 'The archived MapLibre style or resources no longer match the selected version.');
  }
  if (target && Object.keys(config.dggsSources ?? {}).some((id) => Object.hasOwn(fileHashes ?? {}, id) &&
      fileHashes?.[id] !== target.vectorHashes?.[id])) {
    throw new CliError('INVALID_CONFIG', 2, 'The archived DGGS snapshot no longer matches the selected version.');
  }
  const snapshot = { baseVersion, config, yaml, targetVersion, attempt: randomUUID(), sourceHash, vectorHashes: fileHashes, edit,
    maplibreHashes, tlsFingerprint };
  const planId = fingerprint(snapshot);
  await writeMapLibreFiles(planDirectory(planId), mapFiles);
  await writeStateJson(join(planDirectory(planId), 'plan.json'), { ...snapshot, planId });

  const previousUrl = current ? firstPublicationUrl(current) : null;
  const newUrl = firstPublicationUrl(config);
  const changed = changedSource || changedFiles.size > 0 || JSON.stringify(current) !== JSON.stringify(config) ||
    JSON.stringify(currentPlan?.maplibreHashes) !== JSON.stringify(maplibreHashes) || currentPlan?.tlsFingerprint !== tlsFingerprint;
  const previous = new Map(current ? publicationEntries(current) : []);
  const next = new Map(publicationEntries(config));
  const fileChanged = changedSource || current?.sourcePath !== config.sourcePath;
  const platformChanged = current?.publicUrl !== config.publicUrl ||
    JSON.stringify(current?.auth) !== JSON.stringify(config.auth) || JSON.stringify(current?.tls) !== JSON.stringify(config.tls) ||
    currentPlan?.tlsFingerprint !== tlsFingerprint ||
    JSON.stringify(current?.cors) !== JSON.stringify(config.cors);
  const outcomes = [...new Set([...previous.keys(), ...next.keys()])].map((id) => {
    const before = previous.get(id);
    const after = next.get(id);
    return {
      publicationId: id,
      previousUrl: before && current ? publicationUrl(current, id, before) : null,
      newUrl: after ? publicationUrl(config, id, after) : null,
      previousAccess: before?.access ?? null,
      newAccess: after?.access ?? null,
      personalGrants: !after ? 'delete' : before ? 'preserve' : 'none',
    };
  });
  const changedProviders = new Set([...Object.keys(current?.providers ?? {}), ...Object.keys(config.providers ?? {})]
    .filter((id) => JSON.stringify(current?.providers?.[id]?.image ? current.providers[id] : null) !==
      JSON.stringify(config.providers?.[id]?.image ? config.providers[id] : null) ||
      JSON.stringify(current?.providers?.[id]?.postgis) !== JSON.stringify(config.providers?.[id]?.postgis)));
  const dataChanged = (id: string) => (changedSource && hasGeoJson(config, id)) ||
    usedFileSources(config, id).some(([source]) => changedFiles.has(source));
  const restarted = new Set([...changedProviders, ...Object.keys(config.providers ?? {}).filter((id) =>
    !!config.providers?.[id]?.image && (dataChanged(id) || providerConfigurationChanged(config, current, id)))]);
  const builtIn = builtInProviderId(config);
  const mapLibreChanged = (id: string, publication: Publication) => {
    if (!publication.maplibre) return false;
    const prefix = new URL(publicationUrl(config, id, publication)).pathname.slice(1) + '/';
    return Object.entries(maplibreHashes ?? {}).some(([path, hash]) =>
      path.startsWith(prefix) && currentPlan?.maplibreHashes?.[path] !== hash);
  };
  return {
    planId,
    baseVersion,
    targetVersion,
    added: [...next.keys()].filter((id) => !previous.has(id)),
    changed: [...next].filter(([id, publication]) => previous.has(id) &&
      (platformChanged || mapLibreChanged(id, publication) || changedProviders.has(publication.provider) ||
       (publication.tile_provider !== undefined && changedProviders.has(publication.tile_provider)) ||
       changedFiles.has(publication.source) ||
       JSON.stringify(current && fileSource(current, publication.source)) !== JSON.stringify(fileSource(config, publication.source)) ||
       (fileChanged && !postgisSource(config, publication.source) && !fileSource(config, publication.source)) ||
       JSON.stringify(current && postgisSource(current, publication.source)) !== JSON.stringify(postgisSource(config, publication.source)) ||
       JSON.stringify(previous.get(id)) !== JSON.stringify(publication))).map(([id]) => id),
    removed: [...previous.keys()].filter((id) => !next.has(id)),
    previousUrl,
    newUrl,
    previousPublicUrl: current ? new URL(current.publicUrl).origin : null,
    publicUrl: new URL(config.publicUrl).origin,
    publications: outcomes,
    routesToClose: changed ? affectedRoutes(config, current) : [],
    services: changed ? ['caddy', ...((builtIn || (current && builtInProviderId(current))) &&
      ((builtIn && dataChanged(builtIn)) || !currentPlan?.yaml ||
        providerConfigurationChanged(config, current)) ? ['pygeoapi'] : []),
      ...[...restarted].filter((id) => managedProviderRuns(config, id) || (current && managedProviderRuns(current, id)))
        .map((id) => `provider-${id}`),
      ...(needsMetadataService(config) ? ['metadata'] : []),
      ...(config.auth || current?.auth ? ['access'] : []),
      ...(current?.auth?.postgres_password_file !== config.auth?.postgres_password_file ? ['postgres'] : []),
      ...(mailPort(current) !== mailPort(config) ? ['mailpit'] : [])] : [],
  };
}

async function sourceContentChanged(sourceHash: string | null | undefined, baseVersion: string | null) {
  if (!sourceHash || !baseVersion) return false;
  const previousHash = await savedSourceFingerprint(planDirectory(baseVersion));
  return previousHash !== null && previousHash !== sourceHash;
}

async function fileContentChanges(hashes: Plan['vectorHashes'], baseVersion: string | null) {
  if (!hashes || !baseVersion) return new Set<string>();
  const previous = await savedFileFingerprints(planDirectory(baseVersion));
  return new Set(Object.keys(hashes).filter((source) =>
    Object.hasOwn(previous, source) && hashes[source] !== null && previous[source] !== hashes[source]));
}

function mailPort(config: FeaturesConfig | null) {
  return config?.auth?.mode === 'development' ? config.auth.mailpit_port ?? 8025 : null;
}

function revision(plan: Plan) {
  return { config: plan.config, directory: planDirectory(plan.planId), tlsFingerprint: plan.tlsFingerprint };
}

function settled(state: ActiveState, planId: string, outcome: ApplyResult): ActiveState {
  return {
    planId: state.planId, previousVersion: state.previousVersion,
    results: { ...state.results, [planId]: outcome },
  };
}

async function secureGateway(rev: ReturnType<typeof revision>, legacy = false) {
  const { config, directory } = rev;
  if (legacy) {
    await compose(config, directory, 'stop', 'caddy');
  } else {
    await closeGateway(directory).catch(() => compose(config, directory, 'stop', 'caddy'));
  }
}

async function restoreStack(state: ActiveState, candidate: Plan, current: Plan | null, message: string) {
  const { directory } = revision(candidate);
  try {
    await secureGateway(revision(candidate), !candidate.yaml);
    if (current) {
      const previous = revision(current);
      if (!current.yaml) await prepareFeaturesStack(previous, { useArchivedOpenApi: true });
      await closeGateway(previous.directory);
      await startFeaturesStack(previous, revision(candidate));
      await openGateway(previous.directory);
    } else {
      await compose(candidate.config, directory, 'down', '--remove-orphans');
    }
    const outcome = state.results?.[candidate.planId] ?? { code: 'APPLY_FAILED', message };
    await writeActive(settled(state, candidate.planId, outcome));
  } catch {
    await secureGateway(revision(candidate)).catch(() => {});
    if (current) await secureGateway(revision(current), !current.yaml).catch(() => {});
    const outcome = { code: 'RECOVERY_INCOMPLETE', message: 'The previous configuration could not be restored.' } as const;
    await writeActive({ ...state, phase: 'recovery', results: {
      ...state.results, [candidate.planId]: outcome,
    } });
  }
}

function affectedRoutes(candidate: FeaturesConfig, current: FeaturesConfig | null) {
  const versions = current ? [current, candidate] : [candidate];
  return [...new Set(versions.flatMap((config) => [
    config.publicUrl,
    `${config.publicUrl}/collections`,
    `${config.publicUrl}/openapi`,
    ...[...providerRoutes(config)].filter(([, route]) => hasProtocolMetadata(route))
      .flatMap(([root, { protocol }]) => ['', protocol === 'mvt' ? '/catalog' : '/collections', '/openapi', '/conformance']
        .map((suffix) => new URL(root + suffix, config.publicUrl).href)),
    ...publicationEntries(config).map(([id, publication]) => publicationUrl(config, id, publication)),
    ...(config.auth ? ['/account', '/api/auth'].map((path) => new URL(path, config.publicUrl).href) : []),
  ]))];
}

async function openConfirmedVersion(state: ActiveState, candidate: Plan) {
  const confirmed: ActiveState = {
    ...state, phase: 'open', planId: candidate.planId, previousVersion: state.planId,
  };
  await writeActive(confirmed);
  await finishOpen(confirmed, candidate);
}

async function finishOpen(state: ActiveState, candidate: Plan) {
  await persistProviderEdit(candidate);
  const { directory } = revision(candidate);
  try {
    await openGateway(directory);
    await writeActive(settled(state, candidate.planId, { code: 'OK' }));
  } catch (error) {
    if (!candidate.edit) throw error;
    await keepProviderOpenPending(state, candidate);
  }
}

async function keepProviderOpenPending(state: ActiveState, candidate: Plan) {
  // The operator YAML is already committed. Recover this version on retry.
  await secureGateway(revision(candidate)).catch(() => {});
  await writeActive({ ...state, openFailed: true }).catch(() => {});
}

async function resumeProviderOpen(state: ActiveState, candidate: Plan, previous: Plan | null) {
  const rev = revision(candidate);
  try {
    await checkProviderEdit(candidate);
    await closeGateway(rev.directory);
    await startFeaturesStack(rev, previous ? revision(previous) : undefined);
    await finishOpen(state, candidate);
  } catch {
    const saved = await readFile(candidate.edit!.filename, 'utf8').catch(() => null);
    if (state.openFailed || saved === candidate.yaml) {
      await keepProviderOpenPending(state, candidate);
    } else {
      await restoreStack({ ...state, planId: previous?.planId ?? null, previousVersion: previous?.baseVersion ?? null },
        candidate, previous, 'The provider configuration update could not be completed.');
    }
  }
}

async function persistProviderEdit({ edit, yaml }: Plan) {
  if (!edit || yaml === undefined) return;
  const original = await readFile(edit.filename, 'utf8');
  if (original === yaml) return;
  if (digest(original) !== edit.before) throw new Error('The platform YAML changed after planning.');
  const temporaryFile = `${edit.filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, yaml, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporaryFile, edit.filename);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

async function checkProviderEdit({ edit, yaml }: Plan) {
  if (!edit) return;
  const original = await readFile(edit.filename, 'utf8').catch(() => null);
  if (original === null || (digest(original) !== edit.before && original !== yaml)) {
    throw new CliError('PLAN_STALE', 5, 'The platform YAML changed after planning.');
  }
}

async function grantCleanup(plan: Plan, current: Plan | null) {
  if (!current) return;
  const next = new Set(publicationEntries(plan.config).map(([id]) => id));
  const previous = new Set(publicationEntries(current.config).map(([id]) => id));
  const deleteIds = [...previous].filter((id) => !next.has(id));
  const added = new Set([...next].filter((id) => !previous.has(id)));
  if (!deleteIds.length && !added.size) return;

  let accounts: Plan | undefined;
  for await (const version of confirmedHistory(current)) {
    if (version.config.auth) accounts ??= version;
    // Older versions could retire a publication without removing its grants.
    for (const [id] of publicationEntries(version.config)) {
      if (added.delete(id)) deleteIds.push(id);
    }
    if (accounts && !added.size) break;
  }
  if (accounts && deleteIds.length) return { database: revision(plan.config.auth ? plan : accounts), deleteIds };
}

async function finalizeRemoval(state: ActiveState, plan: Plan, current: Plan | null,
  cleanup: NonNullable<Awaited<ReturnType<typeof grantCleanup>>>, resume: boolean) {
  const candidate = revision(plan);
  const { database, deleteIds } = cleanup;
  const temporaryPostgres = !plan.config.auth;
  const runDatabase = (...args: string[]) => compose(database.config, database.directory, ...args);
  let deletionMayHaveRun = resume;
  try {
    if (temporaryPostgres) await runDatabase('up', '-d', '--wait', 'postgres');
    deletionMayHaveRun = true;
    const committed = resume
      ? await publicationGrantRemoval(database, plan.planId, 'abort')
      : await publicationGrantRemoval(database, plan.planId, { deleteIds })
        .catch(() => publicationGrantRemoval(database, plan.planId, 'abort'));
    if (temporaryPostgres) await runDatabase('stop', 'postgres');
    if (!committed) {
      await restoreStack(state, plan, current, 'Publication grants could not be removed. The previous configuration was restored.');
      return;
    }
    if (resume) {
      await closeGateway(candidate.directory);
      await startFeaturesStack(candidate, current ? revision(current) : undefined);
    }
    await openGateway(candidate.directory);
    await writeActive(settled({ ...state, planId: plan.planId, previousVersion: state.planId }, plan.planId, { code: 'OK' }));
  } catch {
    if (!deletionMayHaveRun) {
      await restoreStack(state, plan, current, 'The accounts database could not be started. The previous configuration was restored.');
      return;
    }
    // A lost database response can conceal a commit. Keep the gate closed until
    // the marker is readable, then finish opening or restore the old revision.
    await secureGateway(candidate).catch(() => {});
    await writeActive({ ...state, finalizeFailed: true });
    throw new CliError('RECOVERY_INCOMPLETE', 7, 'Publication removal could not be finalized. Retry the same plan.', {
      planId: plan.planId, currentVersion: state.planId, closedRoutes: state.closedRoutes ?? [],
    });
  }
}

async function activatePlan(state: ActiveState, plan: Plan, current: Plan | null) {
  const candidate = revision(plan);
  const cleanup = await grantCleanup(plan, current);
  await writeActive({ ...state, pendingPlanId: plan.planId, phase: 'preflight' });
  try {
    if (plan.config.tls) {
      const text = process.env.GIS_HTTP_REDIRECT_PORT || '80';
      const port = Number(text);
      if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
        throw new GatewayTlsError('invalid-port', 'GIS_HTTP_REDIRECT_PORT must be a TCP port from 1 to 65535.');
      }
      if (port === plan.config.port) {
        throw new GatewayTlsError('invalid-port', 'The HTTP redirect port must differ from the HTTPS port.');
      }
    }
    const target = plan.targetVersion ? await readPlan(plan.targetVersion) : null;
    await archiveGatewayTls(plan.config, candidate.directory, plan.tlsFingerprint, await tlsSource(plan.config, target));
    if (plan.maplibreHashes) {
      const files = await mapLibreFiles(plan.config, candidate.directory).catch(() => null);
      if (!files || JSON.stringify(mapLibreHashes(files)) !== JSON.stringify(plan.maplibreHashes)) {
        throw new FeaturesPreflightError('The archived MapLibre style or resources no longer match the plan.');
      }
    }
    if (current && !current.yaml) {
      const previous = revision(current);
      await writeFile(join(previous.directory, 'platform.yaml'), serializeFeaturesConfig(current.config), { mode: 0o600 });
      await readFile(join(previous.directory, 'openapi.json')).catch(() => archiveLegacyOpenApi(previous));
    }
    await prepareFeaturesStack(candidate, { previous: current ? revision(current) : undefined,
      sourceHash: plan.sourceHash, fileHashes: plan.vectorHashes });
    if (current) await verifyLegacyGatewayTls(revision(current));
    if (plan.yaml !== undefined) await writeFile(join(candidate.directory, 'platform.yaml'),
      plan.config.providers ? serializeFeaturesConfig(plan.config) : plan.yaml, { mode: 0o600 });
  } catch (error) {
    await writeActive(settled(state, plan.planId, {
      code: 'APPLY_FAILED', message: error instanceof FeaturesPreflightError || error instanceof GatewayTlsError ? error.message
        : 'Preflight failed while checking the source, TLS, native configuration or OpenAPI.',
    }));
    return;
  }
  const pending: ActiveState = {
    ...state, pendingPlanId: plan.planId, phase: 'switch', closedRoutes: affectedRoutes(plan.config, current?.config ?? null),
  };
  await writeActive(pending);
  try {
    await closeGateway(candidate.directory);
    if (current) await secureGateway(revision(current), !current.yaml);
    await startFeaturesStack(candidate, current ? revision(current) : undefined);
    if (!cleanup) await openConfirmedVersion(pending, plan);
    else await writeActive({ ...pending, phase: 'finalize' });
  } catch {
    await restoreStack(pending, plan, current, 'The candidate failed verification and the previous configuration was restored.');
    return;
  }
  if (cleanup) await finalizeRemoval({ ...pending, phase: 'finalize' }, plan, current, cleanup, false);
}

async function applicationLock(scope: string) {
  const lock = createServer((connection) => connection.destroy());
  const key = createHash('sha256').update(scope).digest('hex');
  // The OS releases the lock when the worker exits, including after a forced stop.
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\gis-platform-${key}` : `\0gis-platform-${key}`;
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(path, () => resolve());
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EADDRINUSE', 'EACCES'].includes(String(error.code))) {
      throw new CliError('APPLY_IN_PROGRESS', 5, 'An apply operation is already in progress.');
    }
    throw error;
  }
  return lock;
}

export const restoreMarker = join(stateDirectory, 'status', 'restore-required.json');

export interface RestoreMarker {
  snapshotId: string;
  project?: string;
  reconciled?: { postgres: string; databaseCapturedAt: string };
}

export async function readRestoreMarker(): Promise<RestoreMarker | undefined> {
  return readFile(restoreMarker, 'utf8').then(JSON.parse, (error) => {
    if (missing(error)) return undefined;
    throw error;
  });
}

export function writeRestoreMarker(marker: RestoreMarker) {
  return writeStateJson(restoreMarker, marker);
}

export async function restoredGatewayClosed(planId: string) {
  return stat(join(planDirectory(planId), 'closed')).then(() => true, (error) => {
    if (missing(error)) return false;
    throw error;
  });
}

async function restoreRequired(planId: string | null) {
  const marker = await readRestoreMarker();
  return !!marker && (!marker.reconciled || !planId || await restoredGatewayClosed(planId));
}

async function lockConfiguration(directory: string) {
  const stateLock = await applicationLock(`state:${process.platform === 'win32' ? directory.toLowerCase() : directory}`);
  try {
    const project = await resolveComposeProject();
    const projectLock = await applicationLock(`compose:${project}`);
    return {
      project,
      release() {
        projectLock.close();
        stateLock.close();
      },
    };
  } catch (error) {
    stateLock.close();
    throw error;
  }
}

export async function withConfirmedConfiguration<T>(run: (snapshot: {
  directory: string; project: string; current: Plan; previous: Plan | null; history: AsyncIterable<Plan>;
}) => Promise<T>) {
  const directory = await realpath(stateDirectory);
  const lock = await lockConfiguration(directory);
  try {
    const state = await readActive();
    if (!state.planId || state.pendingPlanId || state.phase) {
      throw new CliError('RECOVERY_INCOMPLETE', 7, 'A settled, confirmed configuration is required. Check status.');
    }
    const current = await readPlan(state.planId);
    return await run({ directory, project: lock.project, current,
      previous: state.previousVersion ? await readPlan(state.previousVersion) : null, history: confirmedHistory(current) });
  } finally {
    lock.release();
  }
}

export async function startRestoredGateway(plan: Plan) {
  const selected = revision(plan);
  await closeGateway(selected.directory);
  await startFeaturesStack(selected);
}

function resultFor(state: ActiveState, plan: Plan) {
  const data = {
    planId: plan.planId, currentVersion: state.planId, url: firstPublicationUrl(plan.config),
  };
  if (plan.edit && state.phase === 'open' && state.pendingPlanId === plan.planId) {
    throw new CliError('RECOVERY_INCOMPLETE', 7, 'The provider YAML was committed. Repeat the plan to reopen the gateway.',
      { ...data, closedRoutes: state.closedRoutes ?? [] });
  }
  const result = state.results?.[plan.planId] ?? { code: 'NO_CHANGE' };
  if (result.code === 'APPLY_FAILED' || result.code === 'RECOVERY_INCOMPLETE') {
    throw new CliError(result.code, result.code === 'APPLY_FAILED' ? 6 : 7, result.message!,
      { ...data, ...(result.code === 'RECOVERY_INCOMPLETE' && { closedRoutes: state.closedRoutes ?? [] }) });
  }
  return { code: result.code, data };
}

export async function applyPlan(planId: string) {
  const plan = await readPlan(planId);
  const lock = await lockConfiguration(await realpath(stateDirectory));
  try {
    if (await readRestoreMarker()) {
      throw new CliError('RECOVERY_INCOMPLETE', 7, 'Restore the verified current accounts database before applying configuration.');
    }
    await migrateActiveFile();
    let state = await readActive();
    if (state.results?.[planId]) return resultFor(state, plan);
    if (state.pendingPlanId) {
      const candidate = await readPlan(state.pendingPlanId);
      const previousId = state.phase === 'open' ? state.previousVersion : state.planId;
      const previous = previousId ? await readPlan(previousId) : null;
      if (state.phase === 'finalize') {
        const cleanup = await grantCleanup(candidate, previous);
        if (!cleanup) throw new CliError('RECOVERY_INCOMPLETE', 7, 'The accounts database could not be found.');
        await finalizeRemoval(state, candidate, previous, cleanup, true);
      } else if (state.phase === 'preflight') {
        await writeActive(settled(state, candidate.planId, {
          code: 'APPLY_FAILED', message: 'The preflight check was interrupted.',
        }));
      } else if (state.phase === 'open' && candidate.edit) {
        await resumeProviderOpen(state, candidate, previous);
      } else {
        if (state.phase === 'open') {
          state = { ...state, planId: previous?.planId ?? null, previousVersion: previous?.baseVersion ?? null };
        }
        await restoreStack(state, candidate, previous, 'The interrupted application was rolled back.');
      }
      state = await readActive();
      if (state.results?.[planId]) return resultFor(state, plan);
      if (state.phase === 'recovery' || state.phase === 'open') return resultFor(state, candidate);
    }
    const current = state.planId ? await readPlan(state.planId) : null;
    if (state.planId === planId) return resultFor(state, plan);
    if (plan.baseVersion !== state.planId) {
      throw new CliError('PLAN_STALE', 5, 'Create a new plan for the active configuration.', {
        planId, baseVersion: plan.baseVersion, currentVersion: state.planId,
      });
    }
    await checkProviderEdit(plan);
    await checkPublicationIdentities(plan.config, current);
    if (current && JSON.stringify(current.config) === JSON.stringify(plan.config) &&
        current.tlsFingerprint === plan.tlsFingerprint &&
        JSON.stringify(current.maplibreHashes) === JSON.stringify(plan.maplibreHashes) &&
        !await sourceContentChanged(plan.sourceHash, current.planId) &&
        !(await fileContentChanges(plan.vectorHashes, current.planId)).size) {
      const sourceChangedAfterPlanning = hasGeoJson(plan.config) &&
        await sourceContentChanged(await sourceFingerprint(plan.config.sourcePath), current.planId);
      const plannedFileHashes = plan.vectorHashes;
      const liveFileHashes = plannedFileHashes && await fileFingerprints(plan.config);
      const fileChangedAfterPlanning = plannedFileHashes && liveFileHashes &&
        (Object.entries(plannedFileHashes).some(([id, hash]) => hash !== null && liveFileHashes[id] !== hash) ||
          (await fileContentChanges(liveFileHashes, current.planId)).size > 0);
      const target = plan.targetVersion ? await readPlan(plan.targetVersion) : null;
      const tlsChangedAfterPlanning = plan.tlsFingerprint !== undefined &&
        await gatewayTlsFingerprint(await tlsSource(plan.config, target)) !== plan.tlsFingerprint;
      if (!sourceChangedAfterPlanning && !fileChangedAfterPlanning && !tlsChangedAfterPlanning && plan.config.providers &&
          !await featuresStackRunning(current.config, revision(current).directory)) {
        await activatePlan(state, plan, current);
        return resultFor(await readActive(), plan);
      }
      const outcome = tlsChangedAfterPlanning
        ? { code: 'APPLY_FAILED', message: 'TLS files changed after planning. Create a new plan.' } as const
        : sourceChangedAfterPlanning || fileChangedAfterPlanning
        ? { code: 'APPLY_FAILED', message: `The ${sourceChangedAfterPlanning ? 'GeoJSON' : 'file'} source changed after planning. Create a new plan.` } as const
        : { code: 'NO_CHANGE' } as const;
      if (outcome.code === 'NO_CHANGE') await persistProviderEdit(plan);
      await writeActive(settled(state, planId, outcome));
    } else {
      await activatePlan(state, plan, current);
    }
    return resultFor(await readActive(), plan);
  } finally {
    lock.release();
  }
}
