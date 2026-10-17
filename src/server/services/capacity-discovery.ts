import type {Place, PlanInput, StartingLocation, Venue} from '../../shared/types.js';
import {estimateWalkingMinutes} from '../providers/walking.js';
import {maximumMinutes} from './planner.js';
import {defaultVisitMinutes} from './visit-duration.js';

/** Used only after scheduling cannot fill a broad request; searches add candidates, never preferences. */
export function capacitySearchQueries({input, venue, startingLocation, minimumCount}: {
  input: PlanInput; venue: Venue; startingLocation?: StartingLocation; minimumCount: number; candidates: Place[];
}): string[] {
  if (minimumCount < 2 || minimumCount > 3) return [];
  const directTravel = estimateWalkingMinutes(startingLocation?.coordinates ?? venue.coordinates, venue.coordinates);
  const visitAllowance = (maximumMinutes(input) - directTravel) / minimumCount;
  // Short local stops leave room for the real route's additional walking legs.
  // Actual retrieved places still pass the full count, budget, hours and route checks.
  return [{query: 'bookstore', category: 'shop' as const}, {query: 'park', category: 'outdoors' as const}]
    .filter(kind => defaultVisitMinutes(kind.category) <= visitAllowance)
    .map(kind => kind.query);
}
