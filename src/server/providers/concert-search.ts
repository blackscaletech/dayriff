import type { City, Venue, VenueSearchResult } from '../../shared/types.js';
import { cleanText, record } from './http.js';
import { normalizeVenue, qlooCoordinates, qlooIdentity, qlooRequest, qlooTaxonomy, type QlooConfig } from './qloo.js';

// Qloo categories identify actual performance spaces, rather than businesses named after a city.
const concertKinds = ['live_music_venue', 'concert_hall', 'performing_arts_theater', 'arena'];
const concertTags = concertKinds.map(kind => `urn:tag:category:place:${kind}`).join(',');
const concertParameters = {'filter.type': 'urn:entity:place', 'filter.tags': concertTags, 'operator.filter.tags': 'union'};
const localityKinds = new Set(['city', 'town', 'village', 'municipality']);
function key(value: string): string { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function cityNameQuery(query: string, city: City): boolean {
  const wanted = key(query), name = key(city.name);
  return wanted === name || wanted === key(`${city.name} ${city.region ?? ''}`) || wanted === key(`${city.name} ${city.region ?? ''} ${city.country ?? ''}`);
}
function cityFromEntity(entity: Record<string, unknown>): City | undefined {
  const item = qlooIdentity(entity, 'locality');
  const coordinates = qlooCoordinates(entity);
  const properties = record(entity.properties);
  if (!item || !coordinates || !localityKinds.has(String(properties.place))) return undefined;
  const ancestors = Array.isArray(properties.ancestors) ? properties.ancestors.map(record) : [];
  const region = cleanText(ancestors.find(ancestor => ['state', 'province', 'region'].includes(String(ancestor.place)))?.name, 100);
  const country = cleanText(ancestors.find(ancestor => ancestor.place === 'country')?.name, 100);
  return {...item, coordinates, ...(region ? {region} : {}), ...(country ? {country} : {})};
}
export function isConcertVenue(entity: Record<string, unknown>): boolean {
  return qlooTaxonomy(entity).some(tag => /^urn:tag:(?:category|genre):place:[a-z_]+$/.test(tag.id) && concertKinds.includes(tag.id.split(':').at(-1)!));
}
function venuesFromEntities(entities: Record<string, unknown>[], city?: City): Venue[] {
  const venues = new Map<string, Venue>();
  for (const entity of entities) {
    if (!isConcertVenue(entity)) continue;
    const venue = normalizeVenue(entity);
    if (venue) venues.set(venue.id, city ? {...venue, city: city.name} : venue);
  }
  return [...venues.values()].slice(0, 10);
}
function matchesVenueQuery(venue: Venue, query: string): boolean {
  const name = key(venue.name), context = key(`${venue.city} ${venue.address}`);
  const tokens = key(query).split(' ').filter(Boolean);
  // City qualifiers can accompany a venue name; address-only matches are not concert-name matches.
  return tokens.some(token => name.includes(token)) && tokens.every(token => name.includes(token) || context.includes(token));
}
async function searchCities(config: QlooConfig, query: string): Promise<City[]> {
  const entities = await qlooRequest(config, '/search', {query, types: 'urn:entity:locality', take: '8'});
  const cities = entities.flatMap(entity => { const city = cityFromEntity(entity); return city ? [city] : []; });
  return [...new Map(cities.map(city => [city.id, city])).values()].sort((a, b) => Number(cityNameQuery(query, b)) - Number(cityNameQuery(query, a))).slice(0, 3);
}
/** A city scopes the search; only an actual concert venue can be selected as the destination. */
export async function searchConcertLocations(config: QlooConfig, query: string, city?: City): Promise<VenueSearchResult> {
  const wanted = cleanText(query, 100);
  if (city && !wanted) {
    const entities = await qlooRequest(config, '/v2/insights', {...concertParameters, 'filter.location': city.id, 'filter.location.radius': '0', take: '10'});
    return {cities: [], venues: venuesFromEntities(entities, city)};
  }
  if (!wanted) return {cities: [], venues: []};
  const cities = city ? [] : await searchCities(config, wanted);
  // A city query should lead to that geography, never namesake restaurants on other continents.
  if (cities.some(found => cityNameQuery(wanted, found))) return {cities, venues: []};
  const entities = await qlooRequest(config, '/search', {query: wanted, types: 'urn:entity:place', 'filter.tags': concertTags,
    'operator.filter.tags': 'union', take: '10', ...(city ? {'filter.location': `${city.coordinates.latitude},${city.coordinates.longitude}`, 'filter.radius': '100'} : {})});
  const matches = venuesFromEntities(entities).filter(venue => matchesVenueQuery(venue, wanted));
  if (!city || !matches.length) return {cities, venues: matches.slice(0, 10 - cities.length)};
  // Search's radius is only a candidate bound. Verify membership in the chosen city's real Qloo polygon.
  const verified = await qlooRequest(config, '/v2/insights', {...concertParameters, 'filter.location': city.id, 'filter.location.radius': '0',
    'filter.results.entities': matches.map(venue => venue.id).join(','), take: '10'});
  const byId = new Map(matches.map(venue => [venue.id, venue]));
  return {cities: [], venues: venuesFromEntities(verified, city).filter(venue => byId.has(venue.id)).map(venue => ({...byId.get(venue.id)!, city: city.name}))};
}
