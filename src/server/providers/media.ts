import type { PlaceImage } from '../../shared/types.js';
import {MAX_PLACE_IMAGES, placeImages} from '../../shared/place-images.js';
import { cleanText, record, safeUrl } from './http.js';

/** Only public Qloo CDN assets go to the browser; provider API URLs and keys never do. */
export function qlooImages(entity: Record<string, unknown>, name: string): PlaceImage[] {
  const properties = record(entity.properties);
  const candidates = [properties.image, ...(Array.isArray(properties.images) ? properties.images.slice(0, MAX_PLACE_IMAGES * 2) : [])];
  const images = candidates.flatMap(candidate => {
    const href = safeUrl(record(candidate).url);
    if (!href) return [];
    const url = new URL(href);
    if (url.hostname !== 'images.qloo.com' || url.port || url.search || url.hash || !url.pathname.startsWith('/i/')) return [];
    return [{url: url.href, alt: cleanText(name, 160), attribution: [{name: 'Qloo', url: 'https://www.qloo.com/'}]}];
  });
  return placeImages({images});
}
export function qlooImage(entity: Record<string, unknown>, name: string): PlaceImage | undefined {
  return qlooImages(entity, name)[0];
}

export function googlePlaceId(entity: Record<string, unknown>): string | undefined {
  const properties = record(entity.properties);
  const external = record(properties.external ?? entity.external);
  // The short `id` in this object is not a Google Maps Place ID.
  const value = record(external.google_place).place_id;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value) ? value : undefined;
}
