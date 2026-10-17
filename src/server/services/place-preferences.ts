import type { Category, Place } from '../../shared/types.js';
import type { PlanPreferences } from './planner.js';
import type { PlacePreference } from './revision-memory.js';

export interface ActivePlacePreference extends PlacePreference { turnSearch?: boolean }
/** Retain compatible tastes, then rebalance older qualitative tastes around the latest request. */
export function resolvePlacePreferences(groups: ActivePlacePreference[], base: PlanPreferences, canFit: (preferences: PlanPreferences) => boolean): PlanPreferences {
  const asGroup = (group: PlacePreference) => ({ids: group.ids, minimum: group.minimum, ...(group.maximum !== undefined ? {maximum: group.maximum} : {})});
  const complete = {...base, requiredPlaceGroups: [...(base.requiredPlaceGroups ?? []), ...groups.map(asGroup)]};
  if (canFit(complete)) return complete;
  return {...base,
    requiredPlaceGroups: [...(base.requiredPlaceGroups ?? []), ...groups.filter(group => group.strength === 'required' || group.maximum === 0 || group.turnSearch).map(asGroup)],
    preferredPlaceGroups: groups.filter(group => group.strength !== 'required' && group.maximum !== 0 && !group.turnSearch).map(asGroup),
  };
}
function normalized(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function clauses(message: string): string[] {
  return message.split(/[.!?;,]|\b(?:and|but|then|also)\b/i).map(normalized).filter(Boolean);
}
function wordKey(value: string): string {
  return value === 'cultural' ? 'culture' : value.replace(/ies$/, 'y').replace(/s$/, '');
}
function mentions(group: Pick<PlacePreference, 'query' | 'category' | 'diningStyle' | 'recognition'>, clause: string): boolean {
  const words = new Set(clause.split(' ').map(wordKey));
  const query = normalized(group.query).split(' ').filter(word => !['the', 'a', 'an'].includes(word)).map(wordKey);
  return Boolean(query.length && query.every(word => words.has(word))) || Boolean(group.category && words.has(wordKey(group.category))) ||
    Boolean(group.diningStyle && /\b(?:fine dining|high end|upscale|luxury)\b/.test(clause)) || Boolean(group.recognition && /\bmichelin\b/.test(clause));
}
function withdrawn(clause: string): boolean {
  if (/\b(?:don't|do not|never|must not)\s+(?:remove|drop|forget|skip|replace)\b/.test(clause) || /\bnot optional\b/.test(clause)) return false;
  return /\b(?:remove|drop|forget|skip|replace)\b|\b(?:don't|do not|no longer)\s+(?:(?:need|want|have)\s+to\s+)?(?:need|require|keep|retain|include)\b|\b(?:not|no longer) (?:necessary|required|needed)\b|\boptional\b/.test(clause);
}
function required(clause: string): boolean {
  return !withdrawn(clause) && (/\b(?:must|only|require|at least|keep|retain)\b/.test(clause.replace(/\bnot only\b/g, '')) || /\b(?:don't|do not|never)\s+(?:remove|drop|replace|change|skip)\b/.test(clause));
}
/** Scope mandatory wording to its own preference clause, not another setting in the message. */
export function isRequiredPreference(group: Pick<PlacePreference, 'query' | 'category' | 'diningStyle' | 'recognition'>, message: string): boolean {
  return clauses(message).some(clause => mentions(group, clause) && required(clause));
}
export function explicitlyRequired(message: string, query?: string, category?: Category): boolean {
  return query ? isRequiredPreference({query, category}, message) : clauses(message).some(required);
}
export function mayDropPreference(group: PlacePreference, message: string): boolean {
  if (group.strength !== 'required' && group.maximum !== 0) return true;
  return clauses(message).some(clause => {
    if (!withdrawn(clause)) return false;
    const direct = /\b(?:remove|drop|forget|skip|replace)\s+(.+?)(?:\s+(?:with|for|in favor of|in favour of)\b|$)/.exec(clause)?.[1];
    const noRequirement = /\b(?:don't|do not|no longer)\s+(?:(?:need|want|have)\s+to\s+)?(?:need|require|keep|retain|include)\s+(.+)/.exec(clause)?.[1];
    const optional = /^(.*?)\boptional\b/.exec(clause)?.[1];
    const noLonger = /^(.*?)\b(?:not|no longer) (?:necessary|required|needed)\b/.exec(clause)?.[1];
    return [direct, noRequirement, optional, noLonger].some(target => target && mentions(group, target));
  }) || clauses(message).some(clause => {
    if (/\b(?:not|never)\b.{0,20}\binstead of\b/.test(clause)) return false;
    const replaced = clause.split(/\binstead of\b/)[1];
    return Boolean(replaced && mentions(group, replaced));
  });
}
export function retainRequestedPreferences<T extends ActivePlacePreference>(groups: T[], message: string, currentStops: Pick<Place, 'id' | 'name' | 'category'>[] = []): T[] {
  return groups.map(group => {
    const keeping = clauses(message).filter(clause => mentions(group, clause) && required(clause));
    if (!keeping.length) return {...group, ids: [...group.ids]};
    const count = currentStops.filter(stop => group.ids.includes(stop.id)).length;
    const minimum = keeping.some(clause => /\b(?:keep|retain)\b|\b(?:don't|do not|never)\s+(?:remove|drop|replace|change|skip)\b/.test(clause)) ? Math.max(group.minimum, count) : group.minimum;
    return {...group, ids: [...group.ids], minimum, strength: 'required'};
  });
}
/** A new search may refresh evidence, but cannot silently relax an earlier mandatory facet. */
export function mergePlacePreference<T extends ActivePlacePreference>(existing: T | undefined, incoming: T, message: string): T {
  if (!existing || mayDropPreference(existing, message)) return {...incoming, ids: [...incoming.ids]};
  const diningRank = {fine_dining: 1, high_end: 2};
  const oldRank = existing.diningStyle ? diningRank[existing.diningStyle] : 0;
  const newRank = incoming.diningStyle ? diningRank[incoming.diningStyle] : 0;
  const diningStyle = newRank > oldRank ? incoming.diningStyle : existing.diningStyle;
  const sameOtherFacets = (!existing.recognition || existing.recognition === incoming.recognition) && (!existing.category || existing.category === incoming.category);
  const ids = newRank > oldRank ? incoming.ids.filter(id => sameOtherFacets || existing.ids.includes(id))
    : newRank === oldRank && sameOtherFacets ? [...new Set([...existing.ids, ...incoming.ids])] : existing.ids;
  return {...existing, ...incoming, strength: 'required', minimum: Math.max(existing.minimum, incoming.minimum), ids: [...ids],
    ...(existing.maximum !== undefined ? {maximum: Math.min(existing.maximum, incoming.maximum ?? 3)} : {}),
    ...(existing.category ? {category: existing.category} : {}), ...(diningStyle ? {diningStyle} : {}), ...(existing.recognition ? {recognition: existing.recognition} : {}),
    ...(existing.exclusive ? {exclusive: true} : {}),
  };
}
