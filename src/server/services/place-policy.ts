import type {Category, DiningStyle} from '../../shared/types.js';
import {defaultTurnIntent, type PlaceRequest, type TurnIntent} from './journey-intent.js';
import type {PlacePreference} from './revision-memory.js';

/** Current-turn evidence only; this boundary never plans or edits schedule constraints. */
export interface PlacePolicyFact {
  effect: 'exclude' | 'withdraw' | 'preserve' | 'include'; quote: string; query: string;
  activeQuery?: string; scope: 'plan' | 'replacement'; targetId?: string;
  category?: Category; diningStyle?: DiningStyle; recognition?: 'michelin';
}
export class PlacePolicyError extends Error { readonly code = 'INVALID_PLACE_POLICY'; }
const key = (value: Pick<PlaceRequest, 'query' | 'scope' | 'category' | 'diningStyle' | 'recognition'>) => JSON.stringify([value.query.toLowerCase(), value.scope ?? 'plan', value.diningStyle ?? '', value.recognition ?? '']);

/** Reconcile only evidence-backed place policy, leaving all other accepted operations intact. */
export function reconcilePlacePolicy(intent: TurnIntent, facts: PlacePolicyFact[], message: string, preferences: PlacePreference[]): TurnIntent {
  const fail = (): never => {throw new PlacePolicyError('I could not confirm that place preference clearly. Your plan is unchanged; please try again.');};
  if (facts.length > 4) fail();
  const active = new Map(preferences.map(preference => [preference.query, preference]));
  const verified = facts.map(fact => {
    if (!fact.quote.trim() || fact.quote.length > 400 || !message.includes(fact.quote) || !fact.query.trim() || fact.query.length > 70) fail();
    const preference = fact.activeQuery === undefined ? undefined : active.get(fact.activeQuery);
    if (fact.activeQuery !== undefined && !preference) fail();
    if (preference?.category && fact.category && preference.category !== fact.category) fail();
    if ((fact.effect === 'withdraw' || fact.effect === 'preserve') && !preference) fail();
    if (fact.scope === 'replacement' && (!intent.replaceStopId || fact.targetId !== intent.replaceStopId || fact.activeQuery !== undefined)) fail();
    if (fact.scope === 'plan' && fact.targetId !== undefined) fail();
    if (fact.scope === 'replacement' && fact.effect !== 'include' && fact.effect !== 'exclude') fail();
    return {...fact, ...(preference && (fact.effect === 'withdraw' || fact.effect === 'preserve') ? {query: preference.query, category: preference.category, diningStyle: preference.diningStyle, recognition: preference.recognition} : {}), preference};
  });
  const excludes = verified.filter(fact => fact.effect === 'exclude');
  const withdrawn = verified.filter(fact => fact.effect === 'withdraw');
  if (verified.some(fact => fact.effect === 'preserve' && fact.activeQuery && verified.some(other => other.activeQuery === fact.activeQuery && other.effect === 'withdraw'))) fail();
  if (excludes.some(exclusion => verified.some(fact => fact.effect === 'include' && key(fact) === key(exclusion)))) fail();
  const result = defaultTurnIntent(intent);
  const drops = new Set<string>(), keeps = new Set<string>();
  for (const fact of verified) {
    if (!fact.activeQuery) continue;
    if (fact.effect === 'withdraw' || (fact.effect === 'include' && fact.preference?.maximum === 0) || (fact.effect === 'exclude' && fact.preference?.maximum !== 0)) drops.add(fact.activeQuery);
    if (fact.effect === 'preserve' && fact.preference?.maximum !== 0) keeps.add(fact.activeQuery);
  }
  if ([...drops].some(query => keeps.has(query))) fail();
  result.dropPreferences = [...drops]; result.keepPreferences = [...keeps];
  // Negative policy must be independently supported, not inferred from the first interpretation.
  result.placeRequests = result.placeRequests.filter(request => request.maximum !== 0 && ![...excludes, ...withdrawn].some(fact => key(fact) === key(request)));
  for (const fact of excludes) {
    if (result.placeRequests.some(request => request.maximum === 0 && key(request) === key(fact))) continue;
    result.placeRequests.push({query: fact.query, minimum: 0, maximum: 0, strength: 'required', scope: fact.scope, exclusive: false,
      ...(fact.category ? {category: fact.category} : {}), ...(fact.diningStyle ? {diningStyle: fact.diningStyle} : {}), ...(fact.recognition ? {recognition: fact.recognition} : {})});
  }
  if (result.placeRequests.length > 4) fail();
  return result;
}
