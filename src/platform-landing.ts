import { builtInProviderId, configuredProviders, providerRouteOwner, providerRoutes, publicationEntries, publicationRoot, publicationUrl,
  type FeaturesConfig, type Publication } from './config.js';
import { publicationAccess, type PublicationReader } from './publication-access.js';

export interface Landing {
  origin: string;
  accounts: boolean;
  providers: { id: string; pages: { protocol: string; url: string }[] }[];
  publications: { id: string; title: string; url: string; access: Publication['access'] }[];
}

export function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function landingFor(config: FeaturesConfig): Landing {
  const entries = publicationEntries(config);
  const builtIn = builtInProviderId(config);
  const ids = Object.keys(configuredProviders(config));
  const providers: Landing['providers'] = ids.map((id) => ({ id, pages: [] }));
  for (const [root, route] of providerRoutes(config)) {
    if (route.protocol === 'mvt') continue;
    const firstPublication = route.protocol === 'tiles'
      ? entries.find(([, publication]) => publicationRoot(config, publication) === root)?.[1] : undefined;
    const id = providerRouteOwner(route, firstPublication) ?? builtIn;
    const provider = providers.find((entry) => entry.id === id);
    const path = route.protocol === 'dggs' ? `${root}/docs` : `${root}?f=html`;
    provider?.pages.push({ protocol: route.protocol, url: new URL(path, config.publicUrl).href });
  }
  return { origin: new URL(config.publicUrl).origin, accounts: Boolean(config.auth), providers,
    publications: entries.map(([id, publication]) => ({ id, title: publication.title, access: publication.access,
      url: publicationUrl(config, id, publication) })) };
}

export const landingPolicy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

export function landingPage(landing: Landing, reader: PublicationReader | null = null) {
  const link = (url: string, label: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  const list = (items: string[], empty: string) => items.length
    ? `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : `<p>${empty}</p>`;
  const accounts = landing.accounts ? `<nav aria-label="Учётная запись">${link(new URL('/account/register', landing.origin).href, 'Регистрация')}
${link(new URL('/account/login', landing.origin).href, 'Вход')}</nav>` : '';
  const providers = list(landing.providers.map(({ id, pages }) => {
    if (!pages.length) return escapeHtml(id);
    if (pages.length === 1) return link(pages[0]!.url, id);
    return `${escapeHtml(id)} · ${pages.map(({ url, protocol }) => link(url, protocol)).join(' · ')}`;
  }), 'Экземпляров пока нет.');
  const publications = list(landing.publications.flatMap(({ id, title, url, access }) =>
    publicationAccess(access, id, reader) === 200 ? [link(url, title)] : []), 'Доступных публикаций пока нет.');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GIS Platform</title><style>
body{margin:0;background:#f4f6f5;color:#172822;font:1rem/1.5 system-ui,sans-serif}
main{max-width:44rem;margin:3rem auto;padding:0 1.25rem} h1{line-height:1.15} h2{margin-top:2rem}
nav{display:flex;gap:1rem;flex-wrap:wrap} li{margin-block:.5rem;overflow-wrap:anywhere} a{color:#215e4e}
</style></head><body><main><h1>GIS Platform</h1>${accounts}
<section><h2>Сервис-провайдеры</h2>${providers}</section>
<section><h2>Публикации</h2>${publications}</section></main></body></html>`;
}
