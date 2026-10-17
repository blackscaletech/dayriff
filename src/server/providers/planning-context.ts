import type { Itinerary, Place } from '../../shared/types.js';

export function compactPlace(place: Place, rank = 0) {
  return {id: place.id, name: place.name, category: place.category, taxonomy: place.taxonomy?.slice(0, 8), coordinates: place.coordinates,
    diningEvidence: place.diningEvidence, costTier: place.costTier ?? 'unknown', durationMinutes: place.durationMinutes,
    description: place.description, recommendationRank: rank + 1};
}
export function shortlist(candidates: Place[], priorityIds: string[]): Place[] {
  const selected = new Map<string, Place>();
  const add = (place: Place | undefined) => {if (place && selected.size < 18) selected.set(place.id, place);};
  priorityIds.forEach(id => add(candidates.find(place => place.id === id)));
  for (const category of ['food', 'culture', 'shop', 'outdoors'] as const) candidates.filter(place => place.category === category).slice(0, 2).forEach(add);
  candidates.forEach(add);
  return [...selected.values()];
}
export function mergeCandidates(current: Place[], fresh: Place[], previous?: Itinerary, priorityIds: string[] = []): Place[] {
  const byId = new Map([...current, ...fresh].map(place => [place.id, place]));
  const order = [...(previous?.stops.map(stop => stop.id) ?? []), ...fresh.map(place => place.id), ...priorityIds, ...current.map(place => place.id)];
  return [...new Set(order)].flatMap(id => byId.get(id) ? [byId.get(id)!] : []).slice(0, 40);
}
