import {setTimeout as pause} from 'node:timers/promises';
import {assertPlanActive, planOperationSignal} from '../services/operation-deadline.js';
import {defaultVisitMinutes} from '../services/visit-duration.js';
import type { PlacePreference } from '../services/revision-memory.js';
import tzLookup from 'tz-lookup';
import { createHash } from 'node:crypto';
import type { Artist, Category, DiningStyle, Coordinates, Place, Venue, StartingLocation } from '../../shared/types.js';
import { cleanText, fetchJson, record, safeWebsiteUrl, ServiceError } from './http.js';
import { distanceMeters, walkingSearchArea, withinWalkingArea } from './walking.js';
import { googlePlaceId, qlooImage, qlooImages } from './media.js';
import {placeImages} from '../../shared/place-images.js';
import { normalizeVisitInfo } from './visit-info.js';
import {isIdentifyingPlaceTag, providerTag, providerTags} from './provider-tags.js';
import { selectCulturalPlaces } from '../services/cultural-quality.js';
import { canonicalDiningQuery, diningEvidence, FINE_DINING_MINUTES, FINE_DINING_TAGS, MICHELIN_COLLECTION, matchesDiningStyle, type DiningFilter } from './dining-evidence.js';

export interface QlooConfig { qlooApiUrl: string; qlooApiKey?: string }
export interface PlaceSearchArea { coordinates: Coordinates; radius: number }
export interface PlaceDiscovery { query: string; places: Place[]; matchedTagIds: string[]; usedTasteRanking: boolean; diningStyle?: DiningStyle; recognition?: 'michelin' }
const searchCache = new Map<string, {expiresAt: number; entities: Record<string, unknown>[]} >();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let nextRequestAt = 0;

function resultItems(value: unknown, kind: 'entities' | 'tags'): Record<string, unknown>[] {
  const results = record(value).results;
  const list = Array.isArray(results) ? results : record(results)[kind];
  if (!Array.isArray(list)) throw new ServiceError('Qloo returned an unexpected response.');
  return list.slice(0, 40).map(record);
}
function identity(entity: Record<string, unknown>, expected: 'artist' | 'place' | 'locality') {
  const id = cleanText(entity.entity_id, 100);
  const name = cleanText(entity.name, 160);
  const subtype = entity.subtype ?? entity.type;
  const types = Array.isArray(entity.types) ? entity.types : [];
  const declaredType = subtype === `urn:entity:${expected}` || subtype === expected || (!subtype && types.includes(`urn:entity:${expected}`));
  if (!uuid.test(id) || !name || !declaredType) return undefined;
  return {id: id.toLowerCase(), name};
}
function coordinates(entity: Record<string, unknown>): Coordinates | undefined {
  const properties = record(entity.properties);
  const location = record(entity.location ?? properties.location);
  const latitude = location.lat ?? location.latitude;
  const longitude = location.lon ?? location.lng ?? location.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return {latitude, longitude};
}
function taxonomy(entity: Record<string, unknown>): {id: string; text: string}[] {
  return providerTags(entity).filter(tag => isIdentifyingPlaceTag(tag.id)).slice(0, 30).map(({id}) => ({id, text: id}));
}
export function placeCategory(entity: Record<string, unknown>): Category {
  const kinds = taxonomy(entity).map(tag => tag.id.split(':place:')[1] ?? '');
  const culturalKind = /^(?:(?:[a-z]+_)*(?:museum|gallery|library|archives?|theat(?:er|re)|cinema)|cultural_(?:center|centre)|arts?_(?:center|centre)|historic(?:al)?_(?:landmark|site|place|house|district|building)|monument|memorial|performing_arts?(?:_[a-z]+)*)(?::|$)/;
  if (kinds.some(kind => culturalKind.test(kind))) return 'culture';
  const text = kinds.join(' ');
  if (/book_?store|book_?shop|record_store|vinyl/.test(text)) return 'shop';
  if (/restaurant|cafe|coffee|bakery|food|dining/.test(text)) return 'food';
  if (/park(?:$|[ :_])|garden|outdoor|waterfront/.test(text)) return 'outdoors';
  if (/shop|store|bookstore|record_store|retail/.test(text)) return 'shop';
  return 'culture';
}
function address(entity: Record<string, unknown>): string {
  const properties = record(entity.properties);
  return cleanText(typeof properties.address === 'string' ? properties.address : entity.address, 240);
}
async function paceRequests() {
  const now = Date.now();
  const delay = Math.max(0, nextRequestAt - now);
  nextRequestAt = now + delay + 250;
  if (delay) await pause(delay, undefined, {signal: planOperationSignal()});
  assertPlanActive();
}
async function request(config: QlooConfig, path: string, params: Record<string, string>, kind: 'entities' | 'tags' = 'entities'): Promise<Record<string, unknown>[]> {
  if (!config.qlooApiKey) throw new ServiceError('Live recommendations are not configured.', 503, 'NOT_CONFIGURED');
  const url = new URL(path, config.qlooApiUrl);
  url.search = new URLSearchParams(params).toString();
  const now = Date.now();
  const cacheable = path === '/search' || path === '/v2/tags' || path === '/entities';
  const cacheKey = `${createHash('sha256').update(config.qlooApiKey).digest('hex').slice(0, 16)}:${url.href.toLowerCase()}`;
  const cached = cacheable ? searchCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > now) return cached.entities;
  if (cached) searchCache.delete(cacheKey);
  await paceRequests();
  let found: Record<string, unknown>[];
  try { found = resultItems(await fetchJson(url, {headers: {'X-Api-Key': config.qlooApiKey, accept: 'application/json'}}, 'Qloo'), kind); }
  catch (error) {
    if (error instanceof ServiceError && error.code === 'PROVIDER_NOT_FOUND') found = [];
    else throw error;
  }
  if (cacheable) {
    for (const [key, entry] of searchCache) if (entry.expiresAt <= now) searchCache.delete(key);
    if (searchCache.size >= 128) searchCache.delete(searchCache.keys().next().value!);
    searchCache.set(cacheKey, {expiresAt: now + 5 * 60_000, entities: found});
  }
  return found;
}
function insightParameters(artist: Artist, venue: Venue, startingLocation?: StartingLocation): Record<string, string> {
  const area = walkingSearchArea(venue, startingLocation);
  return {'filter.type': 'urn:entity:place', 'signal.interests.entities': artist.id,
    'filter.location': `POINT(${area.coordinates.longitude} ${area.coordinates.latitude})`,
    'filter.location.radius': String(area.radius), 'feature.explainability': 'true', 'filter.exclude.entities': [venue.id, startingLocation?.approximate ? undefined : startingLocation?.id].filter(Boolean).join(',')};
}
function normalizePlace(entity: Record<string, unknown>, venue: Venue, tasteMatched: boolean, query?: string, startingLocation?: StartingLocation): Place[] {
  const item = identity(entity, 'place');
  const point = coordinates(entity);
  if (!item || !point || item.id === venue.id || item.id === startingLocation?.id || !withinWalkingArea(venue, point, startingLocation)) return [];
  const properties = record(entity.properties);
  const category = placeCategory(entity);
  const dining = diningEvidence(entity);
  const price = properties.price_level;
  const costTier = typeof price === 'number' && price >= 1 && price <= 4 ? Math.min(3, Math.ceil(price)) as 1 | 2 | 3 : undefined;
  const website = safeWebsiteUrl(properties.website);
  const score = record(entity.query).affinity;
  const affinity = tasteMatched && typeof score === 'number' && score >= 0 && score <= 1 ? score : undefined;
  const images = qlooImages(entity, item.name);
  const image = images[0];
  const googleId = googlePlaceId(entity);
  return [{...item, category, address: address(entity), coordinates: point, ...normalizeVisitInfo(properties),
    description: cleanText(properties.description, 360) || 'A nearby place found by Qloo.',
    ...(website ? {source: {title: `${item.name} website (via Qloo)`, url: website}} : {}),
    ...(costTier ? {costTier} : {}), ...(affinity !== undefined ? {affinity} : {}),
    ...(image ? {image} : {}), ...(images.length > 1 ? {images} : {}), ...(googleId ? {googlePlaceId: googleId} : {}),
    taxonomy: taxonomy(entity).map(tag => tag.id),
    durationMinutes: defaultVisitMinutes(category, dining?.fineDining),
    ...(dining ? {diningEvidence: dining} : {}),
    recommendation: {source: tasteMatched ? 'qloo_taste' : 'qloo_search', ...(query ? {query} : {})},
  }];
}
export function normalizeArtist(entity: Record<string, unknown>): Artist | undefined {
  const item = identity(entity, 'artist');
  if (!item) return undefined;
  const detail = cleanText(record(entity.properties).description, 180);
  const image = qlooImage(entity, item.name);
  return {...item, ...(detail ? {detail} : {}), ...(image ? {image} : {})};
}
export async function searchArtists(config: QlooConfig, query: string): Promise<Artist[]> {
  const list = await request(config, '/search', {query, types: 'urn:entity:artist', take: '8'});
  return list.flatMap(entity => { const artist = normalizeArtist(entity); return artist ? [artist] : []; });
}
export function normalizeVenue(entity: Record<string, unknown>): Venue | undefined {
  const item = identity(entity, 'place');
  const point = coordinates(entity);
  if (!item || !point) return undefined;
  const properties = record(entity.properties);
  const geocode = record(properties.geocode);
  const city = cleanText(geocode.city ?? geocode.name ?? properties.city, 100) || 'Selected location';
  let timezone: string;
  try { timezone = tzLookup(point.latitude, point.longitude); } catch { return undefined; }
  const googleId = googlePlaceId(entity);
  const image = qlooImage(entity, item.name);
  return {...item, city, address: address(entity), coordinates: point, website: safeWebsiteUrl(properties.website) ?? '', timezone, ...(googleId ? {googlePlaceId: googleId} : {}), ...(image ? {image} : {})};
}
export async function searchVenues(config: QlooConfig, query: string, near?: Coordinates): Promise<Venue[]> {
  const list = await request(config, '/search', {query, types: 'urn:entity:place', take: '10', ...(near ? {'filter.location': `${near.latitude},${near.longitude}`, 'filter.radius': '5'} : {})});
  return list.flatMap(entity => { const venue = normalizeVenue(entity); return venue ? [venue] : []; });
}
export async function discoverPlaces(config: QlooConfig, artist: Artist, venue: Venue, startingLocation?: StartingLocation): Promise<Place[]> {
  const list = await request(config, '/v2/insights', {...insightParameters(artist, venue, startingLocation), take: '30'});
  return selectCulturalPlaces(list.flatMap(entity => normalizePlace(entity, venue, true, undefined, startingLocation)));
}
// Canonical UI categories describe a family of places, not a literal business search.
const categoryQueries: Record<Category, readonly string[]> = {
  culture: ['museum', 'art gallery'], food: ['restaurant', 'cafe'], shop: ['bookstore', 'record store'], outdoors: ['park', 'garden'],
};
function broadCategory(query: string): Category | undefined {
  const key = query.trim().toLowerCase();
  return Object.hasOwn(categoryQueries, key) ? key as Category : undefined;
}
function searchKey(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').replace(/s$/, '');
}
/** Ancillary dining tags cannot turn a museum or shop into the requested food stop. */
export function compatiblePlaceQuery(place: Place, query: string, matchedTagIds: string[] = []): boolean {
  if (/\b(?:restaurants?|caf[eé]s?|coffee|baker(?:y|ies)|food|drinks?|dining|bars?|pubs?|diners?|cuisine|breakfast|lunch|dinner|desserts?)\b/i.test(query)) return place.category === 'food';
  if (/\b(?:book[ -]?(?:stores?|shops?)|record[ -]?(?:stores?|shops?))\b/i.test(query)) return place.category === 'shop';
  if (/\b(?:librar(?:y|ies)|archives?)\b/i.test(query)) return place.category === 'culture';
  return !matchedTagIds.some(id => /:(?:restaurant|cafe|coffee_shop|bakery|bar|pub|diner)(?:$|:)/.test(id)) || place.category === 'food';
}
export function matchesPlaceQuery(place: Place, query: string, matchedTagIds: string[] = []): boolean {
  const category = broadCategory(query);
  if (category) return place.category === category;
  if (!compatiblePlaceQuery(place, query, matchedTagIds)) return false;
  if (matchedTagIds.some(id => place.taxonomy?.includes(id))) return true;
  const text = searchKey(`${place.name} ${place.description} ${(place.taxonomy ?? []).join(' ')}`);
  return text.includes(searchKey(query));
}
/** A broad category and a precise subtype are distinct parts of a requested match. */
export function matchesPlacePreference(place: Place, preference: Pick<PlacePreference, 'query' | 'category' | 'diningStyle' | 'matchedTagIds'>): boolean {
  if (preference.category && place.category !== preference.category) return false;
  if (!matchesDiningStyle(place, preference.diningStyle)) return false;
  const broadCategory = preference.category && preference.query.trim().toLowerCase() === preference.category;
  return Boolean(broadCategory) || matchesPlaceQuery(place, preference.query, preference.matchedTagIds);
}
async function resolvePlaceTags(config: QlooConfig, query: string): Promise<string[]> {
  const list = await request(config, '/v2/tags', {'filter.query': query, 'filter.tag.types': 'urn:tag:genre:place,urn:tag:category:place', take: '8'}, 'tags');
  const wanted = searchKey(query);
  const matches = list.flatMap(item => {
    const tag = providerTag(item);
    if (!tag || !isIdentifyingPlaceTag(tag.id)) return [];
    const {id} = tag;
    const name = searchKey(cleanText(item.name ?? item.value) || id.split(':').at(-1)!);
    if (!name || !(name.includes(wanted) || wanted.includes(name))) return [];
    return [{id, score: name === wanted ? 100 : 50 - Math.abs(name.length - wanted.length)}];
  }).sort((a, b) => b.score - a.score);
  if (matches[0]?.score === 100) return matches.filter(match => match.score === 100).slice(0, 3).map(match => match.id);
  return matches.slice(0, 3).map(match => match.id);
}
/** Discover an arbitrary requested kind of stop while keeping the concert location and artist signal. */
export async function findPlaces(config: QlooConfig, artist: Artist, venue: Venue, search: string, startingLocation?: StartingLocation, filter: DiningFilter = {}, searchArea?: PlaceSearchArea): Promise<PlaceDiscovery> {
  const query = filter.diningStyle || filter.recognition ? canonicalDiningQuery(cleanText(search, 70)) : cleanText(search, 70);
  if (query.length < 2 || !searchKey(query) || /https?:|urn:|[\r\n]/i.test(query)) throw new ServiceError('Try a short place preference, such as a type of shop, food, or cultural stop.', 400, 'INVALID_SEARCH');
  const area = searchArea ?? walkingSearchArea(venue, startingLocation);
  const insight = {...insightParameters(artist, venue, startingLocation), ...(searchArea ? {
    'filter.location': `POINT(${area.coordinates.longitude} ${area.coordinates.latitude})`, 'filter.location.radius': String(area.radius),
  } : {})};
  // A focused lookup narrows discovery only; the full outing corridor still validates every provider point.
  const normalize = (entity: Record<string, unknown>, tasteMatched: boolean) => normalizePlace(entity, venue, tasteMatched, query, startingLocation)
    .filter(place => !searchArea || distanceMeters(searchArea.coordinates, place.coordinates) <= searchArea.radius);
  if (filter.diningStyle || filter.recognition) {
    const baseTags = await resolvePlaceTags(config, query);
    const tagGroups = [...(filter.recognition ? [[MICHELIN_COLLECTION]] : []), FINE_DINING_TAGS];
    const byId = new Map<string, Place>();
    for (const tags of tagGroups) {
      const list = await request(config, '/v2/insights', {...insight, 'filter.tags': tags.join(','), 'operator.filter.tags': 'union', take: '12'});
      for (const place of list.flatMap(entity => normalize(entity, true))) {
        if (place.category === 'food' && matchesDiningStyle(place, filter.diningStyle) && matchesPlaceQuery(place, query, baseTags)) {
          const prior = byId.get(place.id);
          byId.set(place.id, {...prior, ...place, diningEvidence: {...prior?.diningEvidence, ...place.diningEvidence}});
        }
      }
    }
    return {query, places: selectCulturalPlaces([...byId.values()]), matchedTagIds: baseTags, usedTasteRanking: true, ...(filter.diningStyle ? {diningStyle: filter.diningStyle} : {}), ...(filter.recognition ? {recognition: filter.recognition} : {})};
  }
  const category = broadCategory(query);
  const queries = category ? categoryQueries[category] : [query];
  const matchedTagIds = [...new Set((await Promise.all(queries.map(subtype => resolvePlaceTags(config, subtype)))).flat())];
  if (matchedTagIds.length) {
    const list = await request(config, '/v2/insights', {...insight, 'filter.tags': matchedTagIds.join(','), 'operator.filter.tags': 'union', take: '12'});
    const places = selectCulturalPlaces(list.flatMap(entity => normalize(entity, true))).filter(place => matchesPlaceQuery(place, query, matchedTagIds));
    if (places.length) return {query, places, matchedTagIds, usedTasteRanking: true};
  }
  const foundById = new Map<string, Place>();
  for (const subtype of queries) {
    const found = await request(config, '/search', {query: subtype, types: 'urn:entity:place', 'filter.location': `${area.coordinates.latitude},${area.coordinates.longitude}`, 'filter.radius': String(startingLocation || searchArea ? (area.radius / 1609.344).toFixed(2) : '1.55'), take: '12'});
    for (const place of found.flatMap(entity => normalize(entity, false)).filter(place => matchesPlaceQuery(place, query, matchedTagIds))) foundById.set(place.id, place);
  }
  const places = selectCulturalPlaces([...foundById.values()]);
  if (!places.length) return {query, places: [], matchedTagIds, usedTasteRanking: false};
  // Search IDs are reranked by the same artist, rather than being presented as unverified taste matches.
  const ranked = await request(config, '/v2/insights', {...insight, 'filter.results.entities': places.map(place => place.id).join(','), take: '12'});
  const byId = new Map(places.map(place => [place.id, place]));
  const tastePlaces = ranked.flatMap(entity => {
    const item = identity(entity, 'place');
    if (!item || !byId.has(item.id)) return [];
    const rankedPlace = normalize(entity, true)[0];
    return rankedPlace && matchesPlaceQuery(rankedPlace, query, matchedTagIds) ? [{...byId.get(item.id)!, ...rankedPlace}] : [];
  });
  const rankedIds = new Set(tastePlaces.map(place => place.id));
  return {query, places: selectCulturalPlaces([...tastePlaces, ...places.filter(place => !rankedIds.has(place.id))]), matchedTagIds, usedTasteRanking: tastePlaces.length > 0};
}

/** Enrich at most three chosen IDs in one cached, optional metadata request. */
export async function enrichSelectedPlaces(config: QlooConfig, _artist: Artist, _venue: Venue, places: Place[]): Promise<Place[]> {
  const selected = places.filter(place => uuid.test(place.id)).slice(0, 3);
  if (!selected.length) return places;
  try {
    const details = await request(config, '/entities', {entity_ids: selected.map(place => place.id).sort().join(',')});
    const byId = new Map(details.flatMap(detail => { const item = identity(detail, 'place'); return item ? [[item.id, detail] as const] : []; }));
    return places.map(place => {
      const detail = byId.get(place.id);
      if (!detail) return place;
      const properties = record(detail.properties);
      const description = cleanText(properties.description, 360);
      const website = safeWebsiteUrl(properties.website);
      const images = placeImages({image: place.image, images: [...(place.images ?? []), ...qlooImages(detail, place.name)]});
      const image = images[0];
      const googleId = googlePlaceId(detail);
      const extraTags = taxonomy(detail).map(tag => tag.id);
      const visitInfo = normalizeVisitInfo(properties);
      const dining = diningEvidence(detail);
      // Metadata cannot relocate or rename an authoritative retrieved candidate, or invent affinity.
      return {...place,
        ...(dining ? {diningEvidence: {...place.diningEvidence, ...dining}, ...(place.category === 'food' && dining.fineDining ? {durationMinutes: FINE_DINING_MINUTES} : {})} : {}),
        ...(!place.phone && visitInfo.phone ? {phone: visitInfo.phone} : {}),
        ...(!place.openingHours?.length && visitInfo.openingHours ? {openingHours: visitInfo.openingHours} : {}),
        ...(!place.neighborhood && visitInfo.neighborhood ? {neighborhood: visitInfo.neighborhood} : {}),
        ...(!place.description || place.description === 'A nearby place found by Qloo.' ? (description ? {description} : {}) : {}),
        ...(!place.address && address(detail) ? {address: address(detail)} : {}),
        ...(!place.source && website ? {source: {title: `${place.name} website (via Qloo)`, url: website}} : {}),
        ...(!place.image && image ? {image} : {}), ...(images.length > 1 ? {images} : {}), ...(!place.googlePlaceId && googleId ? {googlePlaceId: googleId} : {}),
        ...(!place.taxonomy?.length && extraTags.length ? {taxonomy: extraTags} : {}),
      };
    });
  } catch {
    // Descriptive metadata is optional; keep the real recommendation if lookup is unavailable.
    return places;
  }
}

/** Qloo supplies area centroids, or an explicit exact-name public anchor when locality coverage is missing. */
export interface StartingLocality extends StartingLocation {city?: string; localityKind?: 'municipality'}
export async function searchStartingLocalities(config: QlooConfig, query: string, near?: Coordinates, kind: 'locality' | 'anchor' = 'locality'): Promise<StartingLocality[]> {
  const list = await request(config, '/search', {query, types: kind === 'anchor' ? 'urn:entity:place' : 'urn:entity:locality', take: kind === 'anchor' ? '10' : '8', ...(near ? {'filter.location': `${near.latitude},${near.longitude}`, 'filter.radius': '5'} : {})});
  if (kind === 'anchor') {
    const nameKey = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const publicAnchor = /^urn:tag:(?:category|genre):place:(?:tourist_attraction|town_square|plaza|subway_station|train_station|railway_station|transit_station|bus_station|ferry_terminal)$/;
    return list.flatMap(entity => {
      const item = identity(entity, 'place'), point = coordinates(entity);
      if (!item || !point || nameKey(item.name) !== nameKey(query)) return [];
      const properties = record(entity.properties);
      const tags = taxonomy(entity).map(tag => tag.id).filter(tag => tag !== 'urn:tag:genre:place');
      // An attraction tag cannot disguise a private business or an unrecognized place type.
      if (!tags.length || !tags.every(tag => publicAnchor.test(tag))) return [];
      const city = cleanText(record(properties.geocode).city, 100);
      const googleId = googlePlaceId(entity);
      return [{...item, ...(city ? {city} : {}), address: address(entity), coordinates: point,
        ...(googleId ? {googlePlaceId: googleId} : {}), approximate: true, source: {title: 'Qloo area landmark', url: 'https://www.qloo.com/'}}];
    });
  }
  return list.flatMap(entity => {
    const item = identity(entity, 'locality');
    const point = coordinates(entity);
    if (!item || !point) return [];
    const properties = record(entity.properties);
    const municipalityTypes = ['city', 'town', 'village', 'municipality'];
    const municipality = municipalityTypes.includes(String(properties.place));
    if (properties.place && !municipality && !['neighbourhood', 'neighborhood', 'suburb', 'quarter', 'district', 'city_district', 'borough'].includes(String(properties.place))) return [];
    const ancestors = Array.isArray(properties.ancestors) ? properties.ancestors.map(record) : [];
    // A city entity is its own municipality; a neighborhood belongs to its nearest
    // supplied city/town. A county named Los Angeles is not the City of Los Angeles.
    const city = municipality ? item.name : cleanText(ancestors.find(ancestor => municipalityTypes.includes(String(ancestor.place)))?.name ?? record(properties.geocode).city, 100);
    const context = ancestors.filter(ancestor => ['suburb', 'city_district', 'borough', ...municipalityTypes, 'county', 'state', 'province', 'region', 'country'].includes(String(ancestor.place))).map(ancestor => cleanText(ancestor.name, 100));
    return [{...item, ...(city ? {city} : {}), ...(municipality ? {localityKind: 'municipality' as const} : {}), name: item.name, address: [...new Set([item.name, ...context].filter(Boolean))].join(', '), coordinates: point,
      approximate: true, source: {title: 'Qloo locality data', url: 'https://www.qloo.com/'}}];
  });
}

// Shared provider parsing keeps concert lookup and address lookup on the same trust boundary.
export { searchKey as placeSearchKey, request as qlooRequest, identity as qlooIdentity, coordinates as qlooCoordinates, taxonomy as qlooTaxonomy };
