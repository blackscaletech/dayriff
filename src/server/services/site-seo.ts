import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import type {FastifyReply} from 'fastify';
import type {ServerConfig} from '../config.js';
import {escapeHtml, replacePageMetadata} from './page-html.js';
import {SOCIAL_IMAGE} from './social-image.js';

export const SITE_TITLE = 'Dayriff — Make a day of the show';
export const SITE_DESCRIPTION = 'Plan a day around your concert. Discover nearby places inspired by the artist you’re seeing, then follow a walking route that ends at your venue.';
export const SITE_THEME = '#382341';
const NO_INDEX = 'noindex, nofollow, noarchive';

/** Public identity is configured, never taken from Host, query strings, cookies or forwarded headers. */
export function publishedOrigin(config: Pick<ServerConfig, 'production' | 'mode' | 'appOrigin'>): string | undefined {
  if (!config.production || config.mode !== 'live' || !config.appOrigin) return;
  try {
    const url = new URL(config.appOrigin);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.origin !== config.appOrigin || url.username || url.password || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) return;
    return url.origin;
  } catch {return;}
}
function meta(name: string, value: string, property = false): string {return `<meta ${property ? 'property' : 'name'}="${name}" content="${escapeHtml(value)}"/>`;}
/** Escape script delimiters and Unicode line separators even though schema values are trusted constants. */
export function serializeStructuredData(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({'<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029'}[character]!));
}
function structuredData(origin: string): string {
  const url = new URL('/', origin).href, creatorId = `${url}#creator`;
  return serializeStructuredData({'@context': 'https://schema.org', '@graph': [
    {'@type': 'Person', '@id': creatorId, name: 'Ivan Ciraj', sameAs: ['https://x.com/ivanciraj']},
    {'@type': 'WebSite', '@id': `${url}#website`, url, name: 'Dayriff', description: SITE_DESCRIPTION, inLanguage: 'en', creator: {'@id': creatorId}},
    {'@type': 'WebApplication', '@id': `${url}#app`, url, name: 'Dayriff', description: SITE_DESCRIPTION, applicationCategory: 'TravelApplication', operatingSystem: 'Web',
      browserRequirements: 'Requires JavaScript and an internet connection.', creator: {'@id': creatorId},
      featureList: ['Artist-inspired nearby recommendations powered by Qloo taste data', 'Walking routes that finish at the concert venue', 'Conversational plan adjustments', 'Optional arrival time and budget preferences']},
  ]});
}
export interface HomepageHtml {html: string; indexable: boolean; scriptHash?: string}
export function renderHomepageHtml(template: string, config: Pick<ServerConfig, 'production' | 'mode' | 'appOrigin'>, statusCode: 200 | 404 = 200): HomepageHtml {
  const origin = publishedOrigin(config), indexable = Boolean(origin && statusCode === 200);
  const title = statusCode === 404 ? 'Page not found | Dayriff' : SITE_TITLE;
  const tags = [
    `<title>${escapeHtml(title)}</title>`, meta('description', SITE_DESCRIPTION), meta('theme-color', SITE_THEME), meta('application-name', 'Dayriff'), meta('author', 'Ivan Ciraj'),
    meta('robots', indexable ? 'index, follow, max-image-preview:large' : NO_INDEX),
    meta('og:type', 'website', true), meta('og:site_name', 'Dayriff', true), meta('og:title', title, true), meta('og:description', SITE_DESCRIPTION, true),
    meta('twitter:card', 'summary_large_image'), meta('twitter:title', title), meta('twitter:description', SITE_DESCRIPTION), meta('twitter:creator', '@ivanciraj'),
  ];
  let scriptHash: string | undefined;
  if (origin && statusCode === 200) {
    const url = new URL('/', origin).href, image = new URL(SOCIAL_IMAGE.path, origin).href;
    tags.push(`<link rel="canonical" href="${escapeHtml(url)}"/>`, meta('og:url', url, true), meta('og:image', image, true), meta('og:image:secure_url', image, true),
      meta('og:image:type', SOCIAL_IMAGE.type, true), meta('og:image:width', SOCIAL_IMAGE.width, true), meta('og:image:height', SOCIAL_IMAGE.height, true), meta('og:image:alt', SOCIAL_IMAGE.alt, true),
      meta('twitter:image', image), meta('twitter:image:alt', SOCIAL_IMAGE.alt));
    const json = structuredData(origin);
    tags.push(`<script type="application/ld+json">${json}</script>`);
    scriptHash = `'sha256-${createHash('sha256').update(json).digest('base64')}'`;
  }
  return {html: replacePageMetadata(template, tags.join('')), indexable, ...(scriptHash ? {scriptHash} : {})};
}
function addScriptHash(reply: FastifyReply, hash: string) {
  const current = reply.getHeader('Content-Security-Policy');
  // Helmet has already supplied the policy before this handler. Fail closed if absent.
  if (typeof current !== 'string') throw new Error('Homepage structured data requires an existing content security policy.');
  const directives = current.split(';').map(value => value.trim()).filter(Boolean);
  const script = directives.findIndex(value => /^script-src(?:\s|$)/i.test(value));
  if (script >= 0) directives[script] += ` ${hash}`;
  else directives.push(`script-src 'self' ${hash}`);
  reply.header('Content-Security-Policy', directives.join(';'));
}
export function sendHomepageHtml(reply: FastifyReply, template: string, config: Pick<ServerConfig, 'production' | 'mode' | 'appOrigin'>, statusCode: 200 | 404 = 200) {
  const page = renderHomepageHtml(template, config, statusCode);
  if (page.scriptHash) addScriptHash(reply, page.scriptHash);
  if (!page.indexable) reply.header('X-Robots-Tag', NO_INDEX);
  return reply.code(statusCode).type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page.html);
}
export function robotsText(config: Pick<ServerConfig, 'production' | 'mode' | 'appOrigin'>): string {
  const origin = publishedOrigin(config);
  // Shared capabilities carry noindex themselves; crawlers must fetch that directive and social metadata.
  return origin ? `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${new URL('/sitemap.xml', origin).href}\n` : 'User-agent: *\nDisallow: /\n';
}
export function sitemapXml(config: Pick<ServerConfig, 'production' | 'mode' | 'appOrigin'>): string {
  const origin = publishedOrigin(config);
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${origin ? `<url><loc>${escapeHtml(new URL('/', origin).href)}</loc></url>` : ''}</urlset>`;
}
