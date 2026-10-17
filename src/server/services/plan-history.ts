import {randomUUID} from 'node:crypto';
import type {Itinerary, PlanHistoryEntry} from '../../shared/types.js';
import type {RevisionMemory} from './revision-memory.js';

export interface PlanSnapshot {
  id: string; itinerary: Itinerary; excludedIds: string[];
  preferences: RevisionMemory['preferences']; walkingLimit?: number; stopCount?: RevisionMemory['stopCount'];
}
export function capturePlan(itinerary: Itinerary, memory: RevisionMemory | undefined, excludedIds: string[]): PlanSnapshot {
  return structuredClone({id: randomUUID(), itinerary, excludedIds, preferences: memory?.preferences ?? [], ...(memory?.stopCount ? {stopCount: memory.stopCount} : {}), ...(memory?.walkingLimit === undefined ? {} : {walkingLimit: memory.walkingLimit})});
}
export function planHistory(snapshots: PlanSnapshot[] = []): PlanHistoryEntry[] {
  return snapshots.map(({id, itinerary}) => ({id, label: itinerary.revision === 0 ? 'Original plan' : 'Earlier plan',
    schedule: {date: itinerary.input.date, showTime: itinerary.input.showTime, durationMinutes: itinerary.input.durationMinutes, ...(itinerary.input.arrivalBy ? {arrivalBy: itinerary.input.arrivalBy} : {})},
    stops: itinerary.stops.map(({id, name, image}) => ({id, name, ...(image ? {image} : {})})), totalMinutes: itinerary.totalMinutes, totalWalkMinutes: itinerary.totalWalkMinutes}));
}
export function rememberVersion(snapshots: PlanSnapshot[], snapshot: PlanSnapshot): PlanSnapshot[] {
  return [snapshot, ...snapshots].slice(0, 6);
}
