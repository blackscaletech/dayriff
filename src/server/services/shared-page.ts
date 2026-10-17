import type {FastifyRequest} from 'fastify';
import type {Itinerary} from '../../shared/types.js';
import {timeLabel} from '../../shared/format.js';
import type {ServerConfig} from '../config.js';
import {escapeHtml, replacePageMetadata} from './page-html.js';
import {SOCIAL_IMAGE} from './social-image.js';

export interface SharedPageMetadata {title: string; description: string; url: string; image: string; imageAlt: string}
const unavailableTitle = 'Shared plan unavailable | Dayriff';
const unavailableDescription = 'This shared plan is no longer available. Ask your friend for a new Dayriff link, or make a day of your next show.';

/** Production never derives public URLs from Host or forwarded headers. */
export function sharedPageOrigin(config: ServerConfig, request: Pick<FastifyRequest, 'headers'>): string {
  if (config.appOrigin) {
    const configured = new URL(config.appOrigin);
    if (configured.origin !== config.appOrigin || !['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password || (config.production && configured.protocol !== 'https:')) throw new Error('Shared links require an exact app origin.');
    return configured.origin;
  }
  if (config.production) throw new Error('Production shared links require APP_ORIGIN.');
  const host = request.headers.host ?? '';
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) {
    try {return new URL(`http://${host}`).origin;} catch { /* Invalid port falls back to configured local port. */ }
  }
  return `http://localhost:${config.port}`;
}
function showDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'}).format(date) : value;
}
function compact(value: string, maximum: number): string {return value.replace(/\s+/g, ' ').trim().slice(0, maximum);}

export function sharedPageMetadata(origin: string, token: string | undefined, plan?: Itinerary): SharedPageMetadata {
  const image = new URL(SOCIAL_IMAGE.path, origin).href;
  if (!plan || !token) return {title: unavailableTitle, description: unavailableDescription, url: new URL('/shared', origin).href,
    image, imageAlt: SOCIAL_IMAGE.alt};
  const places = plan.stops.map(stop => compact(stop.name, 55)).join(' → ');
  return {title: `${compact(plan.venue.city, 65)} with ${compact(plan.input.artist.name, 105)} | Dayriff`,
    description: compact(`${places}. Before ${compact(plan.input.artist.name, 80)} at ${compact(plan.venue.name, 70)} · ${showDate(plan.input.date)} · ${timeLabel(plan.input.showTime)}.`, 400),
    url: new URL(`/shared/${token}`, origin).href, image, imageAlt: SOCIAL_IMAGE.alt};
}
/** Replace stale generic/social metadata without touching app scripts, CSS or body. */
export function renderSharedPage(template: string, metadata: SharedPageMetadata): string {
  const meta = (name: string, value: string, property = false) => `<meta ${property ? 'property' : 'name'}="${name}" content="${escapeHtml(value)}"/>`;
  const tags = [`<title>${escapeHtml(metadata.title)}</title>`, `<link rel="canonical" href="${escapeHtml(metadata.url)}"/>`, meta('description', metadata.description), meta('theme-color', '#382341'), meta('application-name', 'Dayriff'), meta('robots', 'noindex, nofollow, noarchive'), meta('referrer', 'no-referrer'),
    meta('og:type', 'website', true), meta('og:site_name', 'Dayriff', true), meta('og:title', metadata.title, true), meta('og:description', metadata.description, true),
    meta('og:url', metadata.url, true), meta('og:image', metadata.image, true), meta('og:image:alt', metadata.imageAlt, true),
    meta('og:image:type', SOCIAL_IMAGE.type, true), meta('og:image:width', SOCIAL_IMAGE.width, true), meta('og:image:height', SOCIAL_IMAGE.height, true),
    meta('twitter:card', 'summary_large_image'), meta('twitter:title', metadata.title), meta('twitter:description', metadata.description),
    meta('twitter:image', metadata.image), meta('twitter:image:alt', metadata.imageAlt)].join('');
  const fallback = `<noscript data-dayriff-fallback><div class="app-shell app-shell--home"><main class="planning-screen planning-screen--home"><a class="brand planning-brand" href="/" aria-label="Dayriff home">Dayriff<span>.</span></a><header class="screen-heading"><h1>${escapeHtml(metadata.title.replace(/\s*\|\s*Dayriff$/, ''))}</h1><p>${escapeHtml(metadata.description)}</p></header><p>Enable JavaScript to open Dayriff and view this shared plan.</p></main></div></noscript>`;
  return replacePageMetadata(template, tags).replace(/<noscript\b[^>]*\bdata-dayriff-fallback\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, fallback);
}
