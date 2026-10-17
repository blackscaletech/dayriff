import type { Coordinates, StartingLocation, Venue } from '../../shared/types.js';
import { cleanText, isTerminalProviderFailure, record, ServiceError } from './http.js';
import { normalizeVenue, qlooRequest, searchStartingLocalities, type QlooConfig, type StartingLocality } from './qloo.js';
import {providerTags} from './provider-tags.js';
import { distanceMeters } from './walking.js';

type LocationKind = 'address' | 'place' | 'neighborhood';
function normalized(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function withoutCity(value: string, city: string): string {
  const text = ` ${normalized(value)} `, locality = normalized(city);
  return (locality ? text.split(` ${locality} `).join(' ') : text).trim();
}
function validCoordinates(point: Coordinates): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;
}
function nameScore(location: StartingLocation, query: string, venue: Venue): number {
  if (normalized(location.name) === normalized(query)) return 100;
  const wanted = withoutCity(query, venue.city), candidate = withoutCity(location.name, venue.city);
  if (!wanted || !candidate) return 0;
  if (wanted === candidate) return 100;
  // Interpret a name followed by administrative qualifiers only when those
  // qualifiers are evidenced by the selected venue or returned locality.
  const context = new Set(normalized(`${venue.city} ${venue.address} ${location.address}`).split(' '));
  function matchesAdministrativeContext(value: string): boolean {
    const city = normalized(venue.city);
    // City is optional only after the complete verified venue-city name,
    // never an ignored token attached to a different named location.
    const qualifiers = (` ${normalized(value)} `).split(` ${city} city `).join(` ${city} `).trim();
    return !qualifiers || qualifiers.split(' ').every(word => context.has(word));
  }
  const queryWords = normalized(query).split(' '), nameWords = candidate.split(' ');
  const nameAt = queryWords.findIndex((_, index) => nameWords.every((word, offset) => queryWords[index + offset] === word));
  if (nameAt >= 0) {
    const prefix = queryWords.slice(0, nameAt);
    const suffix = queryWords.slice(nameAt + nameWords.length);
    // Only wording outside the complete provider name is optional. A name such
    // as Garden District retains its District; conflicting city words remain.
    while (suffix.length && ['area', 'neighborhood', 'neighbourhood'].includes(suffix[0]!)) suffix.shift();
    if (prefix.every(word => ['around', 'near', 'in', 'within', 'at', 'by', 'from', 'the', 'starting'].includes(word)) && matchesAdministrativeContext(suffix.join(' '))) return 100;
  }
  const components = query.split(',').map(part => normalized(part)).filter(Boolean);
  const queryName = withoutCity(components[0] ?? '', venue.city);
  const suffix = queryName === candidate && components.length > 1 ? components.slice(1).join(' ') : normalized(query).startsWith(`${candidate} `) ? normalized(query).slice(candidate.length).trim() : '';
  if (suffix && matchesAdministrativeContext(suffix)) return 100;
  const wantedWords = wanted.split(' '), candidateWords = candidate.split(' ');
  if (!wantedWords.every(word => candidateWords.includes(word)) || candidateWords.length > wantedWords.length + 2) return 0;
  return 90 - (candidateWords.length - wantedWords.length) * 2;
}

export type StartingLookup = {status: 'found'; location: StartingLocation} | {status: 'not_found' | 'ambiguous' | 'out_of_range' | 'unavailable'};
/** Canonical lookup text and its administrative context remain separate during validation. */
export function startingSearchQueries(query: string, city: string, kind: 'area' | 'place' | 'address' = 'area'): string[] {
  if (kind !== 'area') return [...new Set([query, query.includes(',') ? query.split(',')[0]!.trim() : `${query}, ${city}`])].slice(0, 2);
  const canonical = query.split(',')[0]!.trim().replace(/^(?:(?:starting|around|near|in|within|at|by|from)\s+)+/iu, '').replace(/\s+(?:area|neighborhood|neighbourhood)$/iu, '').trim();
  return [...new Set([canonical, query.includes(',') ? query : `${canonical}, ${city}`].map(value => value.trim()).filter(Boolean))].slice(0, 2);
}
function cityAliases(value: string): Set<string> {
  const full = normalized(value), base = full.replace(/\s+city$/, '');
  const aliases = [full, base, `${base} city`];
  for (const name of [base, `${base} city`]) {const words = name.split(' '); if (words.length > 1) aliases.push(words.map(word => word[0]).join(''));}
  return new Set(aliases);
}
export function matchesStartingCity(location: Pick<StartingLocation, 'address'> & {city?: string}, city: string, venue: Venue): boolean {
  if (!city.trim()) return true;
  const wanted = normalized(city), venueCity = normalized(venue.city);
  if (location.city && location.city !== 'Selected location') {
    const actual = normalized(location.city);
    return cityAliases(city).has(actual) || cityAliases(location.city).has(wanted);
  }
  // With no structured provider city, only the verified venue-city context is known.
  // Street names such as Boston Road do not establish a different administrative city.
  return cityAliases(city).has(venueCity) || cityAliases(venue.city).has(wanted);
}
/** A generic centre request may use the explicitly named venue only when Qloo proves it is central. */
async function verifiedCityCentreAnchor(config: QlooConfig, query: string, city: string, venue: Venue): Promise<StartingLocation | undefined> {
  const area = withoutCity(query, city).replace(/^the /, '');
  if (!/^(?:downtown|(?:city|town) cent(?:er|re))$/.test(area) || !matchesStartingCity({city: venue.city, address: venue.address}, city, venue)) return undefined;
  const entities = await qlooRequest(config, '/entities', {entity_ids: venue.id});
  for (const entity of entities) {
    const supplied = normalizeVenue(entity);
    const providerCity = cleanText(record(record(entity.properties).geocode).city, 100);
    if (!supplied || supplied.id !== venue.id.toLowerCase() || !providerCity || !matchesStartingCity({city: providerCity, address: supplied.address}, city, venue) || distanceMeters(supplied.coordinates, venue.coordinates) > 150) continue;
    if (!providerTags(entity).some(tag => tag.id === 'urn:tag:setting:qloo:city_center')) continue;
    const label = area === 'downtown' ? 'Downtown' : 'City centre';
    return {id: supplied.id, name: `${label} ${venue.city} · ${supplied.name}`, address: supplied.address, coordinates: supplied.coordinates,
      ...(supplied.googlePlaceId ? {googlePlaceId: supplied.googlePlaceId} : {}), approximate: true,
      source: {title: 'Qloo city-centre venue', url: 'https://www.qloo.com/'}};
  }
  return undefined;
}
/** A provider lookup may establish a location, a real ambiguity, distance or a retryable outage. */
export async function lookupStartingArea(config: QlooConfig, query: string, venue: Venue, city = venue.city): Promise<StartingLookup> {
  const cleanQuery = cleanText(query, 241);
  if (cleanQuery.length < 2 || cleanQuery.length > 240 || /https?:|urn:|[\r\n]/i.test(query) || !validCoordinates(venue.coordinates)) return {status: 'not_found'};
  // For a generic centre request, an explicitly named, verified central venue is
  // more useful than a global search for hundreds of unrelated places called Downtown.
  try {
    const centre = await verifiedCityCentreAnchor(config, cleanQuery, city, venue);
    if (centre) return {status: 'found', location: centre};
  } catch (error) {
    if (!(error instanceof ServiceError) || isTerminalProviderFailure(error)) throw error;
    return {status: 'unavailable'};
  }
  const queries = startingSearchQueries(cleanQuery, city);
  const candidates = new Map<string, StartingLocality>();
  let failed = false, distant = false;
  for (const [index, search] of queries.entries()) {
    try {
      for (const candidate of await searchStartingLocalities(config, search, index === 0 ? venue.coordinates : undefined)) candidates.set(candidate.id ?? `${candidate.name}:${candidate.coordinates.latitude},${candidate.coordinates.longitude}`, candidate);
    } catch (error) {
      if (!(error instanceof ServiceError) || isTerminalProviderFailure(error)) throw error;
      failed = true;
      continue;
    }
    const matches = [...candidates.values()].flatMap(location => {
      if (!validCoordinates(location.coordinates)) return [];
      const score = nameScore(location, cleanQuery, venue);
      if (!score) return [];
      // A named municipality can be an adjacent city rather than a neighborhood
      // inside the concert city. Require the complete provider name and retain the
      // same distance bound; unrelated neighborhoods and explicit other-city
      // constraints still use strict structured-city validation.
      const adjacentMunicipality = location.localityKind === 'municipality' && score === 100 && matchesStartingCity({city: venue.city, address: venue.address}, city, venue);
      if (!matchesStartingCity(location, city, venue) && !adjacentMunicipality) return [];
      if (distanceMeters(venue.coordinates, location.coordinates) > 8_000) {distant = true; return [];}
      return [{location, score}];
    }).sort((a, b) => b.score - a.score);
    const best = matches[0];
    if (best) {
      if (matches.slice(1).some(match => best.score - match.score <= 2 && distanceMeters(best.location.coordinates, match.location.coordinates) > 150)) return {status: 'ambiguous'};
      const {city: _city, localityKind: _localityKind, ...location} = best.location;
      return {status: 'found', location: {...location, source: location.source ?? {title: 'Qloo locality data', url: 'https://www.qloo.com/'}, approximate: true}};
    }
  }
  if (!failed && !distant) {
    // A missing area centroid may have an exact-name public landmark or station.
    // This is one bounded provider lookup, never a fuzzy business or neighboring-area substitution.
    let anchors: (StartingLocation & {city?: string})[];
    try {anchors = await searchStartingLocalities(config, queries[0]!, venue.coordinates, 'anchor');}
    catch (error) {if (!(error instanceof ServiceError) || isTerminalProviderFailure(error)) throw error; return {status: 'unavailable'};}
    const named = anchors.filter(location => validCoordinates(location.coordinates) && matchesStartingCity(location, city, venue));
    const nearby = named.filter(location => distanceMeters(venue.coordinates, location.coordinates) <= 8_000);
    const first = nearby[0];
    if (first) {
      if (nearby.some(location => distanceMeters(first.coordinates, location.coordinates) > 150)) return {status: 'ambiguous'};
      const {city: _city, ...location} = first;
      return {status: 'found', location: {...location, approximate: true}};
    }
    distant = named.length > 0;
  }
  return {status: failed ? 'unavailable' : distant ? 'out_of_range' : 'not_found'};
}
/** Compatibility wrapper for callers that need a location rather than failure provenance. */
export async function geocodeStartingLocation(config: QlooConfig, query: string, kind: LocationKind, venue: Venue): Promise<StartingLocation | undefined> {
  if (kind !== 'neighborhood') return undefined;
  const resolved = await lookupStartingArea(config, query, venue);
  return resolved.status === 'found' ? resolved.location : undefined;
}
