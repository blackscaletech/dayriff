import {isTerminalProviderFailure} from '../errors.js';
import type { Itinerary, Place, StartingLocation } from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import { enrichSelectedPlaces, findPlaces, matchesPlacePreference, placeCategory, placeSearchKey } from '../providers/qloo.js';
import { ServiceError } from '../providers/http.js';
import type { WalkingRoute } from '../providers/walking.js';
import { checkPlan, suggestStopIds, type PlanPreferences } from './planner.js';
import { resolvePlacePreferences } from './place-preferences.js';
import { createRevisionMemory, rememberPlan, type RevisionMemory } from './revision-memory.js';
import {capacitySearchQueries} from './capacity-discovery.js';

interface ReplacementOptions {
  config: ServerConfig; previous: Itinerary; replaceStopId: string; candidates: Place[];
  excludedIds: string[]; memory?: RevisionMemory; startingLocation?: StartingLocation;
}
interface ReplacementResult {
  itinerary?: Itinerary; clarification?: string; candidates: Place[]; excludedIds: string[]; memory: RevisionMemory;
}
/** A specific one-click action needs selection and validation, not another model conversation. */
export async function replaceStop(options: ReplacementOptions): Promise<ReplacementResult> {
  const {config, previous, replaceStopId} = options;
  const target = previous.stops.find(stop => stop.id === replaceStopId);
  if (!target) throw new ServiceError('Choose a current stop to swap.', 400, 'INVALID_STOP');
  const memory = options.memory ?? createRevisionMemory(previous);
  const startingLocation = options.startingLocation ?? previous.startingLocation;
  const excludedIds = [...new Set([...options.excludedIds, replaceStopId])].slice(-80);
  let candidates = [...new Map([...options.candidates, ...previous.stops].map(place => [place.id, place])).values()];
  const preferences = memory.preferences.map(group => ({...group, ids: [...group.ids]}));
  const routeCache = new Map<string, WalkingRoute>();
  const refreshPreferences = () => {for (const group of preferences) group.ids = candidates.filter(place => matchesPlacePreference(place, group)).map(place => place.id);};
  const unchanged = (clarification: string): ReplacementResult => ({clarification, candidates, excludedIds: options.excludedIds, memory});
  const attempt = async (fresh: boolean): Promise<ReplacementResult | undefined> => {
    const blocked = [...excludedIds];
    for (let tried = 0; tried < 3; tried++) {
      const base: PlanPreferences = {...(preferences.some(group => group.exclusive) ? {allowedPlaceIds: [...new Set(preferences.filter(group => group.exclusive).flatMap(group => group.ids))]} : {}), minimumStopCount: memory.stopCount?.minimum, maximumStopCount: memory.stopCount?.maximum, replaceStopId, excludeIds: blocked, preferredWalkMinutes: memory.walkingLimit,
        preferHighEndDining: preferences.some(group => group.diningStyle === 'high_end'),
        seenIds: memory.shown.map(place => place.id), minimumUnseenStops: fresh ? 1 : 0, diversify: true};
      const constraints = resolvePlacePreferences(preferences, base, preference => suggestStopIds(previous.input, previous.venue, candidates, preference, previous, startingLocation).length > 0);
      const ids = suggestStopIds(previous.input, previous.venue, candidates, constraints, previous, startingLocation);
      if (!ids.length) return undefined;
      const checked = await checkPlan({ids, input: previous.input, venue: previous.venue, candidates, previous, preferences: constraints,
        mode: previous.mode, apiKey: config.googleMapsApiKey, routeCache, startingLocation});
      const replacementId = ids.find(id => !previous.stops.some(stop => stop.id === id))!;
      if (!checked.itinerary) { blocked.push(replacementId); continue; }
      const enriched = await enrichSelectedPlaces(config, previous.input.artist, previous.venue, checked.itinerary.stops.filter(stop => stop.id === replacementId));
      const details = new Map(enriched.map(place => [place.id, place]));
      candidates = candidates.map(place => details.get(place.id) ?? place);
      refreshPreferences();
      const updated = resolvePlacePreferences(preferences, {...base, ...(preferences.some(group => group.exclusive) ? {allowedPlaceIds: [...new Set(preferences.filter(group => group.exclusive).flatMap(group => group.ids))]} : {})}, preference => suggestStopIds(previous.input, previous.venue, candidates, preference, previous, startingLocation).length > 0);
      const final = await checkPlan({ids, input: previous.input, venue: previous.venue, candidates, previous, preferences: updated,
        mode: previous.mode, apiKey: config.googleMapsApiKey, routeCache, startingLocation});
      if (!final.itinerary) { blocked.push(replacementId); continue; }
      return {itinerary: final.itinerary, candidates, excludedIds, memory: rememberPlan(memory, final.itinerary, preferences)};
    }
    return undefined;
  };
  const cached = await attempt(true);
  if (cached) return cached;
  // Prefer a similar stop, then explore a short alternative kind when the accepted requirements allow it.
  const indispensable = preferences.find(group => (group.strength === 'required' || group.exclusive) && group.ids.includes(replaceStopId) && previous.stops.filter(stop => group.ids.includes(stop.id)).length <= group.minimum);
  const typeQuery = target.taxonomy?.filter(tag => placeCategory({tags: [tag]}) === target.category)
    .map(tag => tag.split(':').at(-1)!.replace(/_/g, ' '))
    .find(tag => /book ?store|record store|museum|art gallery|historic landmark|garden|park|cafe|restaurant|bakery/.test(tag));
  const query = indispensable?.query ?? typeQuery ?? ({culture: 'museum', food: 'restaurant', shop: 'bookstore', outdoors: 'park'} as const)[target.category];
  const broader = !indispensable && !preferences.some(group => group.exclusive) ? capacitySearchQueries({input: previous.input, venue: previous.venue, startingLocation, minimumCount: Math.max(2, previous.stops.length), candidates}) : [];
  const queries = [...new Map([query, ...broader].map(search => [placeSearchKey(search), search])).values()].slice(0, 2);
  const searchArea = {coordinates: target.coordinates, radius: 1_000};
  let lookupFailed = false;
  for (const search of queries) {
    try {
      const found = await findPlaces(config, previous.input.artist, previous.venue, search, startingLocation, {diningStyle: indispensable?.diningStyle, recognition: indispensable?.recognition}, searchArea);
      const all = new Map([...candidates, ...found.places].map(place => [place.id, place]));
      const priority = [...previous.stops.map(stop => stop.id), ...found.places.map(place => place.id), ...preferences.flatMap(group => group.ids), ...candidates.map(place => place.id)];
      candidates = [...new Set(priority)].flatMap(id => all.get(id) ? [all.get(id)!] : []).slice(0, 40);
      refreshPreferences();
      const replacement = await attempt(true) ?? await attempt(false);
      if (replacement) return replacement;
    } catch (error) {
      if (!(error instanceof ServiceError) || isTerminalProviderFailure(error)) throw error;
      lookupFailed = true;
    }
  }
  const existing = await attempt(false);
  if (existing) return existing;
  if (lookupFailed) throw new ServiceError('Another stop could not be loaded right now. Your current route is still here; please try again.', 503, 'REPLACEMENT_UNAVAILABLE');
  return unchanged(`I could not find a replacement for ${target.name} that keeps your other stops and fits your time and preferences. Your route is unchanged. Try allowing more time or adjusting a preference.`);
}
