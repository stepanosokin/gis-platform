import { writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { CliError } from './cli-result.js';
import { configuredProviders, pinnedImage, providerProtocols, providerServiceName, publicationEntries, publicationUrl,
  type FeaturesConfig } from './config.js';
import { compose } from './features-stack.js';
import { withConfirmedConfiguration } from './plans.js';
import { escapeHtml } from './platform-landing.js';

function publicationRows(config: FeaturesConfig) {
  return publicationEntries(config).map(([id, publication]) => ({
    id, title: publication.title, url: publicationUrl(config, id, publication), protocol: publication.protocol,
    provider: publication.provider, source: publication.source, access: publication.access,
    tileProvider: publication.tile_provider ?? null,
  }));
}

export function publicationInventory() {
  return withConfirmedConfiguration(async ({ current }) => ({
    currentVersion: current.planId, publications: publicationRows(current.config),
  }));
}

interface ComposeContainer { Name: string; Service: string; Image: string; State: string }

export function providerInventory() {
  return withConfirmedConfiguration(async ({ current, currentRevision }) => {
    const config = current.config;
    const [ps, rawCompose] = await Promise.all([
      compose(config, currentRevision.directory, 'ps', '--all', '--format', 'json'),
      compose(config, currentRevision.directory, 'config', '--format', 'json'),
    ]);
    const inventory = ps.trim();
    const containers: ComposeContainer[] = inventory.startsWith('[') ? JSON.parse(inventory) :
      inventory.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const project = JSON.parse(rawCompose) as { services: Record<string, { image?: string }> };
    return { currentVersion: current.planId, providers: Object.entries(configuredProviders(config)).map(([id, provider]) => {
      const service = providerServiceName(config, id);
      const container = containers.find((entry) => entry.Service === service);
      return { id, service, type: provider.type, container: container?.Name ?? null, state: container?.State ?? null,
        image: provider.image ? pinnedImage(provider) : project.services[service]?.image ?? container?.Image ?? null,
        protocols: providerProtocols(provider) };
    }) };
  });
}

export function reportFilename(filename: string, extension: string) {
  if (extname(filename).toLowerCase() !== extension) {
    throw new CliError('INVALID_INPUT', 2, `The report filename must end with ${extension}.`);
  }
  return resolve(filename);
}

export async function writeReport(filename: string, contents: string | Uint8Array) {
  await writeFile(filename, contents, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new CliError('INVALID_INPUT', 2, 'The report file already exists. Choose a new filename.');
    throw new CliError('FAILED', 1, 'The report could not be saved. Check the destination directory.');
  });
}

export async function writeConfigurationDiagram(output: string) {
  const file = reportFilename(output, '.html');
  const result = await withConfirmedConfiguration(async ({ current }) => {
    const config = current.config;
    const publications = publicationRows(config);
    const linkedProviders = new Set(publications.flatMap(({ provider, tileProvider }) => tileProvider ?
      [provider, tileProvider] : [provider]));
    const idle = Object.keys(configuredProviders(config)).filter((id) => !linkedProviders.has(id));
    const origin = new URL(config.publicUrl).origin;
    const link = (url: string, label: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    const node = (label: string, content: string, detail = '') =>
      `<li><small>${label}</small><strong>${content}</strong>${detail ? `<span>${detail}</span>` : ''}</li>`;
    const chains = publications.map((publication) => {
      const connection = config.postgisSources?.[publication.source]?.connection;
      return `<ol class="chain" aria-label="${escapeHtml(publication.id)}">${[
        node('Источник', escapeHtml(publication.source), connection ? `PostGIS · ${escapeHtml(connection)}` : ''),
        node('Публикация', link(publication.url, publication.title), `${publication.protocol} · ${publication.access}`),
        node('Экземпляр сервис-провайдера', escapeHtml(publication.provider), publication.tileProvider ?
          `Рендерер тайлов · ${escapeHtml(publication.tileProvider)}` : ''),
        node('Шлюз', link(origin, origin)),
      ].join('')}</ol>`;
    });
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Схема GIS Platform</title>
<style>
body{margin:0;background:#f4f6f5;color:#172822;font:1rem/1.5 system-ui,sans-serif}
main{max-width:76rem;margin:3rem auto;padding:0 1.25rem}a{color:#215e4e}code{overflow-wrap:anywhere}
.chain{padding:0;list-style:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2rem}
.chain li{position:relative;padding:1rem;background:white;border:1px solid #b4c9bf;border-radius:.5rem;overflow-wrap:anywhere}
.chain li+li::before{content:'→';position:absolute;left:-1.55rem;top:35%;color:#215e4e;font-weight:bold}
small,strong,span{display:block}small{color:#34584b}strong{margin:.25rem 0}span{font-size:.875rem}
@media(max-width:45rem){.chain{grid-template-columns:1fr}.chain li+li::before{content:'↓';left:1rem;top:-1.8rem}}
</style></head><body><main><h1>Схема GIS Platform</h1>
<p>Действующая версия <code>${current.planId}</code></p>
${chains.length ? chains.join('\n') : '<p>Публикаций пока нет.</p>'}
${idle.length ? `<section><h2>Экземпляры без публикаций</h2><ul>${idle.map((id) => `<li>${escapeHtml(id)}</li>`).join('')}</ul></section>` : ''}
</main></body></html>`;
    return { currentVersion: current.planId, html };
  });
  await writeReport(file, result.html);
  return { file, currentVersion: result.currentVersion };
}
