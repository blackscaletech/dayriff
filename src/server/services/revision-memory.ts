import type { StopCountBounds } from './journey-intent.js';
import type { Category, DiningStyle, Itinerary } from '../../shared/types.js';

export interface PlacePreference {
  query: string; ids: string[]; minimum: number; maximum?: number; matchedTagIds?: string[]; category?: Category;
  strength?: 'preference' | 'required'; exclusive?: boolean; diningStyle?: DiningStyle; recognition?: 'michelin';
}
export interface RevisionMemory {
  shown: {id: string; name: string}[];
  plans: string[][];
  preferences: PlacePreference[];
  stopCount?: StopCountBounds;
  /** Remembered qualitative walking target; only explicit per-plan limits are hard constraints. */
  walkingLimit?: number;
}
export function createRevisionMemory(previous?: Itinerary): RevisionMemory {
  return {shown: previous?.stops.map(stop => ({id: stop.id, name: stop.name})) ?? [], plans: previous ? [previous.stops.map(stop => stop.id)] : [], preferences: []};
}
export function rememberPlan(memory: RevisionMemory, itinerary: Itinerary, preferences = memory.preferences, walkingLimit = memory.walkingLimit, stopCount: StopCountBounds | null | undefined = memory.stopCount): RevisionMemory {
  const shown = new Map(memory.shown.map(place => [place.id, place]));
  for (const stop of itinerary.stops) { shown.delete(stop.id); shown.set(stop.id, {id: stop.id, name: stop.name}); }
  const ids = itinerary.stops.map(stop => stop.id);
  const last = memory.plans.at(-1);
  const plans = last?.join('|') === ids.join('|') ? memory.plans : [...memory.plans, ids].slice(-6);
  const required = preferences.filter(group => group.strength === 'required' || group.maximum === 0);
  const remembered = [...required, ...preferences.filter(group => group.strength !== 'required' && group.maximum !== 0).slice(-Math.max(0, 8 - required.length))];
  return {...(stopCount ? {stopCount: {...stopCount}} : {}), shown: [...shown.values()].slice(-80), plans, preferences: remembered.map(preference => ({...preference, ids: [...new Set(preference.ids)].slice(0, 40)})), ...(walkingLimit !== undefined ? {walkingLimit} : {})};
}
export function samePlan(a: Itinerary, b: Itinerary): boolean {
  return a.stops.map(stop => stop.id).join('|') === b.stops.map(stop => stop.id).join('|') &&
    a.totalWalkMinutes === b.totalWalkMinutes && a.totalMinutes === b.totalMinutes &&
    a.input.budget === b.input.budget && a.input.arrivalBy === b.input.arrivalBy && a.input.showTime === b.input.showTime &&
    a.input.date === b.input.date && a.input.durationMinutes === b.input.durationMinutes && a.input.startingPoint === b.input.startingPoint;
}
