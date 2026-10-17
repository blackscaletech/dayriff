import type {Category, Place} from '../shared/types';

export const categoryNames: Record<Category, string> = {food: 'Food & drink', culture: 'Culture', shop: 'Shopping', outdoors: 'Outdoors'};

export function placeDescription(place: Pick<Place, 'description'>): string {
  const description = place.description.trim();
  return /^a nearby place (?:found|recommended|discovered) (?:by|through|with) qloo[.!]?$/i.test(description) ? '' : description;
}

export function placeContext(place: Pick<Place, 'localNote' | 'description'>): string {
  return place.localNote?.trim() || placeDescription(place);
}
