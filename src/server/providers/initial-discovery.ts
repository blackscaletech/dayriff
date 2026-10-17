import type {Place, PlanInput, StartingLocation, Venue} from '../../shared/types.js';
import {suggestStopIds} from '../services/planner.js';
import {mergeCandidates} from './planning-context.js';
import {discoverPlaces, findPlaces, type QlooConfig} from './qloo.js';

/** Missing artist-affinity coverage must not prevent a real local outing. */
export async function discoverInitialPlaces(config: QlooConfig, input: PlanInput, venue: Venue, startingLocation?: StartingLocation): Promise<Place[]> {
  let candidates = await discoverPlaces(config, input.artist, venue, startingLocation);
  if (suggestStopIds(input, venue, candidates, {}, undefined, startingLocation).length) return candidates;
  for (const query of ['bookstore', 'cafe']) {
    const found = await findPlaces(config, input.artist, venue, query, startingLocation);
    candidates = mergeCandidates(candidates, found.places);
    if (suggestStopIds(input, venue, candidates, {}, undefined, startingLocation).length) break;
  }
  return candidates;
}
