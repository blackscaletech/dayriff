import type {Category} from '../../shared/types.js';

export const QUICK_VISIT_MINUTES = 25;
export const STANDARD_VISIT_MINUTES = 35;
export const FINE_DINING_MINUTES = 90;
/** Shared planning allowances; actual availability and visit lengths remain unverified. */
export function defaultVisitMinutes(category: Category, fineDining = false): number {
  return category === 'food' && fineDining ? FINE_DINING_MINUTES : category === 'food' || category === 'culture' ? STANDARD_VISIT_MINUTES : QUICK_VISIT_MINUTES;
}
