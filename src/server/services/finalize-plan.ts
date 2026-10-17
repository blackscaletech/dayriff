import type { Itinerary, Place, PlanInput, StartingLocation, Venue } from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import { enrichSelectedPlaces } from '../providers/qloo.js';
import { mergeCandidates } from '../providers/planning-context.js';
import type { WalkingRoute } from '../providers/walking.js';
import { applyGroundedNotes, type GroundedStopNote } from './grounded-notes.js';
import { checkPlan, suggestStopIds, type PlanPreferences } from './planner.js';

/** Optional metadata cannot bypass timing, count, required tastes or known listed hours. */
export async function finalizePlan(options: {config: ServerConfig; checked: Itinerary; input: PlanInput; venue: Venue; candidates: Place[];
  previous?: Itinerary; preferences: PlanPreferences; resolvePreferences?: (candidates: Place[]) => PlanPreferences; startingLocation?: StartingLocation; routeCache: Map<string, WalkingRoute>; notes?: GroundedStopNote[]}): Promise<{itinerary?: Itinerary; candidates: Place[]}> {
  let selected = options.checked, candidates = options.candidates;
  for (let attempt = 0; attempt < 3; attempt++) {
    const enriched = applyGroundedNotes(await enrichSelectedPlaces(options.config, options.input.artist, options.venue, selected.stops), options.notes ?? []);
    candidates = mergeCandidates(candidates, enriched, options.previous);
    const preferences = options.resolvePreferences?.(candidates) ?? options.preferences;
    const checked = await checkPlan({...options, preferences, ids: selected.stops.map(stop => stop.id), candidates, mode: selected.mode, apiKey: options.config.googleMapsApiKey});
    if (checked.itinerary) return {itinerary: checked.itinerary, candidates};
    if (attempt === 2) break;
    const ids = suggestStopIds(options.input, options.venue, candidates, preferences, options.previous, options.startingLocation);
    if (!ids.length || ids.join('|') === selected.stops.map(stop => stop.id).join('|')) break;
    const retry = await checkPlan({...options, preferences, ids, candidates, mode: selected.mode, apiKey: options.config.googleMapsApiKey});
    if (!retry.itinerary) break;
    selected = retry.itinerary;
  }
  return {candidates};
}
