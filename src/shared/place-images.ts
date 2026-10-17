import type {Place, PlaceImage} from './types.js';

export const MAX_PLACE_IMAGES = 5;

function imageKey(value: string): string {
  try {
    const url = new URL(value);
    // A second size of the same Qloo asset is not another photograph.
    const path = url.hostname === 'images.qloo.com'
      ? url.pathname.replace(/-\d+x-(?:auto|\d+)(?=\.(?:jpe?g|png|webp)$)/i, '') : url.pathname;
    return `${url.origin}${path}`;
  } catch {return value;}
}

/** Keep the existing cover first, with a small, stable set of distinct photographs. */
export function placeImages(place: Pick<Place, 'image' | 'images'>): PlaceImage[] {
  const found: PlaceImage[] = [], seen = new Set<string>();
  for (const image of [place.image, ...(place.images ?? []).slice(0, MAX_PLACE_IMAGES * 2)]) {
    if (!image?.url) continue;
    const key = imageKey(image.url);
    if (seen.has(key)) continue;
    seen.add(key); found.push(image);
    if (found.length === MAX_PLACE_IMAGES) break;
  }
  return found;
}
