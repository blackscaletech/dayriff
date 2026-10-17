import type { Budget, Category, DiningStyle, Itinerary, PlanInput, StartingLocation, Venue } from '../../shared/types.js';
import {timeLabel} from '../../shared/format.js';
import type { PlacePreference } from './revision-memory.js';

export interface StopCountBounds { minimum: number; maximum: number }
export interface PlaceRequest {
  query: string; minimum: number; maximum?: number; operation?: 'increase'; scope?: 'plan' | 'replacement'; strength: 'preference' | 'required'; exclusive?: boolean; category?: Category;
  diningStyle?: DiningStyle; recognition?: 'michelin';
}
/** One semantically interpreted request, shared by routing, planning and the reply. */
export interface TurnIntent {
  kind: 'answer' | 'adjust' | 'alternatives' | 'restore' | 'clarify';
  stopCount?: StopCountBounds | null;
  placeScope: 'unchanged' | 'any' | 'reset';
  placeRequests: PlaceRequest[]; dropPreferences: string[]; keepPreferences: string[];
  replaceStopId?: string; minimumChanges: number; showTimeUpdate: string; durationUpdate: 'unchanged' | number; budgetUpdate: 'unchanged' | 'unset' | Budget; arrivalUpdate: string;
  walking: 'unchanged' | 'less' | 'clear_limit'; rejectIds: string[]; restoreIds: string[]; keepStopIds: string[];
  clarification?: string; changesPlan: boolean;
}
export type JourneyIntent = TurnIntent;

export function defaultTurnIntent(overrides: Partial<TurnIntent> = {}): TurnIntent {
  return {kind: 'answer', placeScope: 'unchanged', minimumChanges: 0,
    showTimeUpdate: 'unchanged', durationUpdate: 'unchanged', budgetUpdate: 'unchanged', arrivalUpdate: 'unchanged', walking: 'unchanged', changesPlan: false,
    ...overrides, ...(overrides.stopCount ? {stopCount: {...overrides.stopCount}} : {}),
    placeRequests: (overrides.placeRequests ?? []).map(request => ({...request})),
    dropPreferences: [...(overrides.dropPreferences ?? [])], keepPreferences: [...(overrides.keepPreferences ?? [])],
    rejectIds: [...(overrides.rejectIds ?? [])], restoreIds: [...(overrides.restoreIds ?? [])], keepStopIds: [...(overrides.keepStopIds ?? [])],
  };
}
interface IntentContext { message: string; currentCount: number; preferences: PlacePreference[]; trustedPlaceIds: string[]; currentPlaceIds?: string[] }
/** Validate interpreted operations and trusted references; do not reinterpret natural language. */
export function validateTurnIntent(intent: TurnIntent, context: IntentContext): TurnIntent {
  const result = defaultTurnIntent(intent);
  const clarify = (clarification: string): TurnIntent => defaultTurnIntent({kind: 'clarify', clarification});
  const count = result.stopCount;
  if (result.keepStopIds.length > 3 || new Set(result.keepStopIds).size !== result.keepStopIds.length || result.keepStopIds.some(id => !context.currentPlaceIds?.includes(id))) return clarify('Which current places would you like to keep? Choose places in your current plan.');
  if (result.keepStopIds.some(id => result.rejectIds.includes(id) || id === result.replaceStopId)) return clarify('Would you like to keep that current place or replace it? Your plan is unchanged.');
  if (result.replaceStopId && !context.currentPlaceIds?.includes(result.replaceStopId)) return clarify('Which current stop would you like to replace? Choose a place in your current plan.');
  if (count && (!Number.isInteger(count.minimum) || !Number.isInteger(count.maximum) || count.minimum < 1 || count.maximum > 3 || count.minimum > count.maximum)) {
    return clarify('Dayriff supports one to three stops in a single outing. Your plan is unchanged; ask for up to three stops or allow more time for the outing.');
  }
  if (!Number.isInteger(result.minimumChanges) || result.minimumChanges < 0 || result.minimumChanges > 3) return clarify('How many places would you like to replace? A Dayriff outing supports up to three stops.');
  if (!/^(?:unchanged|(?:[01]\d|2[0-3]):[0-5]\d)$/.test(result.showTimeUpdate)) return clarify('What time does the show start? Use a time such as 7 pm or 19:00.');
  if (result.durationUpdate !== 'unchanged' && (!Number.isInteger(result.durationUpdate) || result.durationUpdate < 30 || result.durationUpdate > 480)) return clarify('Choose between 30 minutes and 8 hours to explore before arriving at the venue.');
  if (!/^(?:unchanged|unset|(?:[01]\d|2[0-3]):[0-5]\d)$/.test(result.arrivalUpdate)) return clarify('What arrival time do you mean? Use a time such as 7 pm or 19:00.');
  if (result.placeRequests.length > 4 || result.placeRequests.some(request => !request.query.trim() || request.query.length > 70 || !Number.isInteger(request.minimum) || request.minimum < 0 || request.minimum > 3 || (request.minimum === 0 && request.maximum === undefined) || (request.maximum !== undefined && (!Number.isInteger(request.maximum) || request.maximum < request.minimum || request.maximum > 3)))) return clarify('Choose a matching-place range between zero and three; a zero minimum needs a maximum.');
  if (result.placeRequests.some(request => request.scope === 'replacement') && !result.replaceStopId) return clarify('Which current stop should this replacement be for? Choose one place in your current plan.');
  if (result.placeRequests.some(request => request.scope === 'replacement' && request.minimum > 1)) return clarify('A single-stop replacement contains one place. Use a whole-plan requirement for counts across the outing.');
  if (result.placeRequests.some(request => request.exclusive && request.maximum === 0)) return clarify('A plan cannot contain only a kind of place and exclude that same kind. Which do you prefer?');
  // Whole-plan exclusivity constrains every stop; a replacement kind is already bound to its one new ID.
  result.placeRequests = result.placeRequests.map(request => ({...request, ...(request.maximum === 0 || request.exclusive ? {strength: 'required' as const} : {}), ...(request.exclusive && request.scope === 'replacement' ? {exclusive: false} : {})}));
  const knownQueries = new Map(context.preferences.map(group => [group.query.toLowerCase(), group.query]));
  const resolveQueries = (queries: string[]): string[] | undefined => {
    if (queries.some(query => !knownQueries.has(query.toLowerCase()))) return undefined;
    return [...new Set(queries.map(query => knownQueries.get(query.toLowerCase())!))];
  };
  const dropped = resolveQueries(result.dropPreferences), kept = resolveQueries(result.keepPreferences);
  if (!dropped || !kept) return clarify('Which existing place preference would you like to keep or remove?');
  if (dropped.some(query => kept.includes(query))) return clarify('Would you like to keep that place preference or remove it?');
  result.dropPreferences = dropped; result.keepPreferences = kept;
  const trustedIds = new Set(context.trustedPlaceIds);
  if ([...result.rejectIds, ...result.restoreIds].some(id => !trustedIds.has(id))) return clarify('Which place from your plan or earlier options would you like to change?');
  result.rejectIds = [...new Set(result.rejectIds)]; result.restoreIds = [...new Set(result.restoreIds)];
  if (result.rejectIds.some(id => result.restoreIds.includes(id))) return clarify('Would you like to bring that place back or leave it out?');
  if (result.kind === 'restore' && !result.restoreIds.length) return clarify('Which earlier place would you like to bring back?');
  if (result.kind === 'clarify') return clarify(result.clarification?.trim() || 'What would you like to change about your outing?');
  const updates = Boolean(result.replaceStopId) || result.stopCount !== undefined || result.placeScope !== 'unchanged' || result.placeRequests.length > 0 || dropped.length > 0 || kept.length > 0 ||
    result.minimumChanges > 0 || result.showTimeUpdate !== 'unchanged' || result.durationUpdate !== 'unchanged' || result.budgetUpdate !== 'unchanged' || result.arrivalUpdate !== 'unchanged' || result.walking !== 'unchanged' || result.rejectIds.length > 0 || result.restoreIds.length > 0;
  if (result.kind === 'answer' && updates) result.kind = 'adjust';
  if (result.replaceStopId) result.minimumChanges = 1;
  else if (result.kind === 'alternatives' || result.placeRequests.some(request => request.operation === 'increase')) result.minimumChanges = Math.max(1, result.minimumChanges);
  result.changesPlan = result.kind !== 'answer';
  return result;
}

/** Positive taste scope never edits submitted times, budget, origin or place exclusions. */
export function applyPlaceScope<T extends PlacePreference>(groups: T[], intent: TurnIntent, _message?: string): T[] {
  const drops = new Set(intent.dropPreferences.map(query => query.toLowerCase()));
  const keeps = new Set(intent.keepPreferences.map(query => query.toLowerCase()));
  return groups.filter(group => !drops.has(group.query.toLowerCase()) && (keeps.has(group.query.toLowerCase()) || group.maximum === 0 || intent.placeScope === 'unchanged' || (intent.placeScope === 'any' && group.strength === 'required')))
    .map(group => ({...group, ids: [...group.ids], ...(keeps.has(group.query.toLowerCase()) ? {strength: 'required' as const} : {})}));
}
export function journeyMessage(intent: TurnIntent, itinerary: Itinerary): string | undefined {
  if (intent.kind === 'answer' || intent.kind === 'clarify') return undefined;
  if (intent.stopCount && (itinerary.stops.length < intent.stopCount.minimum || itinerary.stops.length > intent.stopCount.maximum)) return undefined;
  return [intent.placeScope === 'any' ? 'Opened your plan to different kinds of places while keeping required preferences.' : intent.placeScope === 'reset' ? 'Cleared earlier place preferences.' : '',
    intent.dropPreferences.length ? `Removed the ${intent.dropPreferences.join(' and ')} preference${intent.dropPreferences.length > 1 ? 's' : ''}.` : '',
    intent.keepPreferences.length ? `Kept ${intent.keepPreferences.join(' and ')} as required.` : '',
    intent.stopCount ? `Your plan has ${itinerary.stops.length} ${itinerary.stops.length === 1 ? 'stop' : 'stops'}.` : intent.stopCount === null ? 'Removed the stop-count preference.' : '',
    intent.walking === 'clear_limit' ? 'Cleared the shorter-walk preference.' : '',
    ...intent.placeRequests.filter(request => request.maximum !== undefined).map(request => `${request.scope === 'replacement' ? 'The replacement' : 'Your plan'} ${request.maximum === 0 ? `excludes ${request.query} stops` : `allows at most ${request.maximum} ${request.query} ${request.maximum === 1 ? 'stop' : 'stops'}`}.`),
  ].filter(Boolean).join(' ') || undefined;
}
export function stopCountLimit(bounds: StopCountBounds, input: PlanInput, venue: Venue, start: StartingLocation | undefined, feasibleCount: number): string {
  const requested = bounds.minimum === bounds.maximum ? `${bounds.minimum} ${bounds.minimum === 1 ? 'stop' : 'stops'}` : bounds.minimum > 1 ? `at least ${bounds.minimum} stops` : `no more than ${bounds.maximum} ${bounds.maximum === 1 ? 'stop' : 'stops'}`;
  const constraints = [`${input.durationMinutes}-minute outing before the ${timeLabel(input.showTime)} show`, ...(input.budget ? [`${input.budget} budget`] : []), ...(input.arrivalBy ? [`arrival by ${timeLabel(input.arrivalBy)}`] : [])].join(', ');
  return `I could not fit ${requested} into your ${constraints} from ${start?.name ?? venue.name} to ${venue.name}${feasibleCount ? `; the verified options fit ${feasibleCount} ${feasibleCount === 1 ? 'stop' : 'stops'}` : ''}. Your plan is unchanged. Allow more time or relax a required preference to make room.`;
}
