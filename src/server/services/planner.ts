import { randomUUID } from 'node:crypto';
import type { AppMode, Budget, Itinerary, Place, PlanInput, Stop, Venue, StartingLocation } from '../../shared/types.js';
import {derivePlanningWindow, dateAtMinutes, clockTime, type PlanningWindow} from '../../shared/planning-window.js';
import {timeLabel} from '../../shared/format.js';
import { listedVisitFits } from './listed-hours.js';
import { culturalQuality, isCulturallyEligible } from './cultural-quality.js';
import { directionsUrl, estimatedLegs, walkingRoute, walkingLegUrl, distanceMeters, withinWalkingArea, type WalkingRoute } from '../providers/walking.js';

export interface PlanPreferences {
  minimumStopCount?: number; maximumStopCount?: number; allowedPlaceIds?: string[];
  diversify?: boolean; preferRetainedStops?: boolean; minimumChangedStops?: number; minimumUnseenStops?: number; seenIds?: string[]; maximumWalkMinutes?: number; preferredWalkMinutes?: number;
  lessWalking?: boolean; excludeIds?: string[]; replaceStopId?: string; category?: Place['category']; minimumCategoryCount?: number; requiredPlaceGroups?: {ids: string[]; minimum: number; maximum?: number}[]; preferredPlaceGroups?: {ids: string[]; minimum: number; maximum?: number}[]; preferMichelinCollection?: boolean; preferHighEndDining?: boolean }
export interface PlanCheck { valid: boolean; issues: string[]; itinerary?: Itinerary }
function preservesSwap(ids: string[], previous: Itinerary, replaceStopId: string): boolean {
  const index = previous.stops.findIndex(stop => stop.id === replaceStopId);
  return index >= 0 && ids.length === previous.stops.length && ids.every((id, position) =>
    position === index ? !previous.stops.some(stop => stop.id === id) : id === previous.stops[position]!.id);
}
export function maximumMinutes(input: PlanInput): number {
  derivePlanningWindow(input);
  return input.durationMinutes;
}
export function budgetAllows(place: Place, budget?: Budget): boolean {
  if (!budget || budget === 'high') return true;
  // Unknown prices cannot be advertised as a known low/medium-price match.
  return place.costTier !== undefined && place.costTier <= (budget === 'low' ? 1 : 2);
}
function permutations<T>(items: T[]): T[][] {
  return items.length <= 1 ? [items] : items.flatMap((item, index) => permutations(items.filter((_, i) => index !== i)).map(rest => [item, ...rest]));
}
/** Small exhaustive search: at most 40 candidates × 3 stops; no model-generated routing arithmetic. */
export function suggestStopIds(input: PlanInput, venue: Venue, candidates: Place[], preferences: PlanPreferences = {}, previous?: Itinerary, startingLocation: StartingLocation | undefined = previous?.startingLocation): string[] {
  let window: PlanningWindow;
  try { window = derivePlanningWindow(input); } catch { return []; }
  const eligible = candidates.filter(place => isCulturallyEligible(place) && (!preferences.allowedPlaceIds || preferences.allowedPlaceIds.includes(place.id)) && !preferences.excludeIds?.includes(place.id) && budgetAllows(place, input.budget) && withinWalkingArea(venue, place.coordinates, startingLocation));
  let best: {ids: string[]; score: number; retained: number} | undefined;
  const previousIds = new Set(previous?.stops.map(stop => stop.id) ?? []);
  const seenIds = new Set(preferences.seenIds ?? []);
  const walkLimit = preferences.lessWalking && previous ? previous.totalWalkMinutes : Infinity;
  function consider(selected: Place[]) {
    if (selected.length < (preferences.minimumStopCount ?? 1) || selected.length > (preferences.maximumStopCount ?? 3)) return;
    if (preferences.lessWalking && previous && selected.length > previous.stops.length && (preferences.minimumStopCount ?? 1) <= previous.stops.length) return;
    if (previous && selected.filter(place => !previousIds.has(place.id)).length < (preferences.minimumChangedStops ?? 0)) return;
    if (selected.filter(place => !seenIds.has(place.id)).length < (preferences.minimumUnseenStops ?? 0)) return;
    if (preferences.requiredPlaceGroups?.some(group => {const matches = selected.filter(place => group.ids.includes(place.id)).length; return matches < group.minimum || matches > (group.maximum ?? Infinity);})) return;
    if (preferences.category && selected.filter(place => place.category === preferences.category).length < (preferences.minimumCategoryCount ?? 1)) return;
    for (const ordered of permutations(selected)) {
      if (preferences.replaceStopId && (!previous || !preservesSwap(ordered.map(place => place.id), previous, preferences.replaceStopId))) continue;
      const legs = estimatedLegs(venue, ordered, startingLocation);
      let visitClock = window.startMinutes;
      if (ordered.some((place, index) => { visitClock += legs[index]!; const fits = listedVisitFits(place, input.date, visitClock); visitClock += place.durationMinutes; return !fits; })) continue;
      const walk = legs.reduce((sum, leg) => sum + leg, 0);
      const total = walk + ordered.reduce((sum, place) => sum + place.durationMinutes, 0);
      if (total > input.durationMinutes || walk >= walkLimit || walk > (preferences.maximumWalkMinutes ?? Infinity)) continue;
      const retained = previous ? ordered.filter(place => previous.stops.some(stop => stop.id === place.id)).length : 0;
      const variety = new Set(ordered.map(place => place.category)).size;
      const affinity = ordered.reduce((sum, place) => sum + (place.affinity ?? (1 - candidates.indexOf(place) / Math.max(candidates.length, 1))), 0);
      const culturalValue = ordered.reduce((sum, place) => sum + culturalQuality(place), 0);
      const originalCategory = previous?.stops.find(stop => stop.id === preferences.replaceStopId)?.category;
      const similarReplacement = preferences.replaceStopId && ordered.some(place => !previousIds.has(place.id) && place.category === originalCategory) ? 12 : 0;
      const walkingTradeoff = Math.max(0, walk - (preferences.preferredWalkMinutes ?? Infinity)) * 4;
      const rememberedTaste = preferences.preferredPlaceGroups?.reduce((sum, group) => sum + (Math.min(group.minimum, selected.filter(place => group.ids.includes(place.id)).length) - Math.max(0, selected.filter(place => group.ids.includes(place.id)).length - (group.maximum ?? Infinity))) * 40, 0) ?? 0;
      const recognitionTaste = preferences.preferMichelinCollection ? selected.filter(place => place.diningEvidence?.michelinCollection).length * 30 : 0;
      const premiumTaste = preferences.preferHighEndDining ? selected.filter(place => place.diningEvidence?.fineDining).reduce((sum, place) => sum + (place.costTier === 3 ? 50 : place.costTier === 2 ? 10 : 0), 0) : 0;
      const score = premiumTaste + similarReplacement + rememberedTaste + recognitionTaste - walkingTradeoff + (preferences.lessWalking ? -walk * 100 + variety * 3 + affinity : variety * 10 + affinity * 8 + culturalValue * 16 + retained * (preferences.diversify ? 0 : 10) + (preferences.diversify ? ordered.filter(place => !seenIds.has(place.id)).length * 15 : 0) - walk * .2);
      // Count stays first; a refinement changes only as many existing places as needed.
      const betterSameCount = best && (preferences.preferRetainedStops && retained !== best.retained ? retained > best.retained : score > best.score);
      if (!best || selected.length > best.ids.length || (selected.length === best.ids.length && betterSameCount)) best = {ids: ordered.map(place => place.id), score, retained};
    }
  }
  if (preferences.replaceStopId) {
    if (!previous || !previousIds.has(preferences.replaceStopId)) return [];
    const byId = new Map(eligible.map(place => [place.id, place]));
    for (const alternative of eligible.filter(place => !previousIds.has(place.id))) {
      const slots = previous.stops.map(stop => stop.id === preferences.replaceStopId ? alternative : byId.get(stop.id));
      if (slots.every((place): place is Place => Boolean(place))) consider(slots);
    }
    return best?.ids ?? [];
  }
  for (let a = 0; a < eligible.length; a++) {
    consider([eligible[a]!]);
    for (let b = a + 1; b < eligible.length; b++) {
      consider([eligible[a]!, eligible[b]!]);
      for (let c = b + 1; c < eligible.length; c++) consider([eligible[a]!, eligible[b]!, eligible[c]!]);
    }
  }
  return best?.ids ?? [];
}
export async function checkPlan(options: {
  ids: string[]; input: PlanInput; venue: Venue; candidates: Place[]; mode: AppMode;
  apiKey?: string; startingLocation?: StartingLocation; previous?: Itinerary; preferences?: PlanPreferences; routeCache?: Map<string, WalkingRoute>;
}): Promise<PlanCheck> {
  const {ids, input, venue, candidates, previous, preferences = {}} = options;
  const startingLocation = options.startingLocation ?? previous?.startingLocation;
  const issues: string[] = [];
  let window: PlanningWindow;
  try { window = derivePlanningWindow(input); } catch (error) { return {valid: false, issues: [error instanceof Error ? error.message : 'Check your show and arrival times.']}; }
  if (startingLocation && distanceMeters(venue.coordinates, startingLocation.coordinates) > 8_000) return {valid: false, issues: ['Choose a starting point within walking reach of the venue.']};
  if (ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length) return {valid: false, issues: ['Choose between one and three distinct stops.']};
  const places = ids.map(id => candidates.find(place => place.id === id));
  if (places.some(place => !place)) return {valid: false, issues: ['Choose only from the supplied candidate IDs.']};
  const selected = places as Place[];
  if (selected.length < (preferences.minimumStopCount ?? 1)) issues.push(`This request requires at least ${preferences.minimumStopCount} stops in the complete outing.`);
  if (selected.length > (preferences.maximumStopCount ?? 3)) issues.push(`This request allows at most ${preferences.maximumStopCount} stops in the complete outing.`);
  if (preferences.replaceStopId && (!previous || !preservesSwap(ids, previous, preferences.replaceStopId))) issues.push('A one-stop swap must replace only the chosen stop, keeping every other stop in its current position and the same stop count.');
  if (previous && selected.filter(place => !previous.stops.some(stop => stop.id === place.id)).length < (preferences.minimumChangedStops ?? 0)) issues.push('An alternative must change actual places, not just reorder the same stops.');
  if (selected.filter(place => !preferences.seenIds?.includes(place.id)).length < (preferences.minimumUnseenStops ?? 0)) issues.push('Use fresh places that have not already been shown when a suitable fresh option exists.');
  if (preferences.allowedPlaceIds && selected.some(place => !preferences.allowedPlaceIds!.includes(place.id))) issues.push('Every stop must match the requested exclusive kinds of places.');
  if (selected.some(place => !isCulturallyEligible(place))) issues.push('Choose distinctive local or cultural stops rather than generic chains or unsuitable businesses.');
  if (selected.some(place => preferences.excludeIds?.includes(place.id))) issues.push('A rejected stop is still selected.');
  if (selected.some(place => !budgetAllows(place, input.budget))) issues.push('A stop does not have a known price tier within the selected budget preference.');
  if (selected.some(place => !withinWalkingArea(venue, place.coordinates, startingLocation))) issues.push('A stop is outside the supported walking area.');
  if (preferences.requiredPlaceGroups?.some(group => {const matches = selected.filter(place => group.ids.includes(place.id)).length; return matches < group.minimum || matches > (group.maximum ?? Infinity);})) issues.push('Keep each requested kind within its required minimum and maximum.');
  if (preferences.category && selected.filter(place => place.category === preferences.category).length < (preferences.minimumCategoryCount ?? 1)) issues.push(`Include ${preferences.minimumCategoryCount ?? 1} available ${preferences.category} stops.`);
  if (issues.length) return {valid: false, issues};
  const key = `${startingLocation?.coordinates.latitude ?? venue.coordinates.latitude},${startingLocation?.coordinates.longitude ?? venue.coordinates.longitude}:${ids.join('|')}`;
  const route = options.routeCache?.get(key) ?? await walkingRoute(venue, selected, options.apiKey, startingLocation);
  options.routeCache?.set(key, route);
  const totalWalkMinutes = route.legs.reduce((sum, leg) => sum + leg, 0);
  const totalMinutes = totalWalkMinutes + selected.reduce((sum, place) => sum + place.durationMinutes, 0);
  if (totalWalkMinutes > (preferences.maximumWalkMinutes ?? Infinity)) issues.push('Keep the previously requested walking limit, unless the user explicitly relaxes it.');
  if (totalMinutes > maximumMinutes(input)) issues.push('This route needs more time than your exploration window before venue arrival. Allow more time to explore, remove a stop, or choose closer stops.');
  if (preferences.lessWalking && previous && totalWalkMinutes >= previous.totalWalkMinutes) issues.push('The revised plan must have less total walking than the existing plan.');
  if (issues.length) return {valid: false, issues};
  let clock = window.startMinutes;
  const stops: Stop[] = selected.map((place, index) => {
    const walkMinutes = route.legs[index]!;
    clock += walkMinutes;
    const arrivalTime = clockTime(clock);
    const arrivalDate = dateAtMinutes(input.date, clock);
    if (!listedVisitFits(place, input.date, clock)) issues.push(`${place.name}'s listed hours do not cover this estimated visit. Choose another stop or change the time.`);
    clock += place.durationMinutes;
    return {...place, arrivalTime, arrivalDate, departureTime: clockTime(clock), departureDate: dateAtMinutes(input.date, clock), walkMinutes,
      directionsUrl: walkingLegUrl(index === 0 ? startingLocation ?? venue : selected[index - 1]!, place, venue.city)};
  });
  if (issues.length) return {valid: false, issues};
  const notices = [
    ...(options.mode === 'sample' ? ['Sample experience: curated New York places, illustrative selections, and no live Qloo or AI calls.'] : []),
    ...(route.notice ? [route.notice] : ['Walking times come from Google Routes and remain estimates. Follow current pedestrian directions and local conditions.']),
    'Suggested visit lengths are planning estimates. Check opening hours, tickets, prices, accessibility, and entry rules directly before visiting.',
    ...(input.budget ? ['Budget uses broad price tiers, not a guaranteed total. Places with unknown prices are excluded from low and medium preferences.'] : []),
    input.arrivalBy ? `Your exploration window ends at your selected venue-arrival time, ${timeLabel(window.arrivalTime)}. Allow time for venue security and queues.` : `Your exploration window ends 30 minutes before the ${timeLabel(input.showTime)} show. Allow additional time if your venue requires earlier entry.`,
  ];
  return {valid: true, issues: [], itinerary: {
    id: previous?.id ?? randomUUID(), mode: options.mode, input, venue, ...(startingLocation ? {startingLocation} : {}), stops, totalWalkMinutes, totalMinutes,
    estimatedArrival: clockTime(window.startMinutes + totalMinutes), estimatedArrivalDate: dateAtMinutes(input.date, window.startMinutes + totalMinutes), routeUrl: directionsUrl(venue, selected, startingLocation), venueDirectionsUrl: walkingLegUrl(selected[selected.length - 1]!, venue, venue.city), notices, revision: previous ? previous.revision + 1 : 0,
  }};
}
