import type { Itinerary, Place, PlanInput, RevisionInput, Venue, StartingLocation } from '../../shared/types.js';
import { planInputSchema } from '../validation.js';
import {derivePlanningWindow} from '../../shared/planning-window.js';
import {timeLabel} from '../../shared/format.js';
import {budgetAllows, type PlanPreferences} from './planner.js';
import type { PlacePreference } from './revision-memory.js';

export interface RevisionIntent { input: PlanInput; preferences: PlanPreferences; clarification?: string }
/** Conservative recognition supports optimized suggestions without overriding negated requests. */
export function knownRevisionPreferences(previous: Itinerary | undefined, message: string): PlanPreferences {
  const preferences: PlanPreferences = {};
  const clauses = message.toLowerCase().split(/[.!?;,]|\bbut\b|\band\b/).filter(clause => !/\b(?:not|don't|do not|never|avoid|no)\b/.test(clause));
  if (clauses.some(clause => /less walking|walk less|shorter walk|closer (?:places|stops)|reduce.*walk/.test(clause))) preferences.lessWalking = true;
  if (clauses.some(clause => /more cultur/.test(clause))) preferences.category = 'culture';
  if (clauses.some(clause => /more food/.test(clause))) preferences.category = 'food';
  if (clauses.some(clause => /more outdoor/.test(clause))) preferences.category = 'outdoors';
  if (preferences.category) preferences.minimumCategoryCount = Math.min(3, (previous?.stops.filter(stop => stop.category === preferences.category).length ?? 0) + 1);
  return preferences;
}
export function asksForAlternatives(message: string): boolean {
  const text = message.toLowerCase();
  if (/^\s*(?:why|explain|what makes|how did|tell me why)\b/.test(text)) return false;
  return text.split(/[.!?;,]|\bbut\b|\band\b/).some(clause => !/\b(?:not|don't|do not|never|no)\b/.test(clause) && /something (?:else|different|new)|different (?:places|stops|recommendations|plan)|new (?:places|stops|recommendations|plan)|other (?:places|stops|options)|alternatives?|less repetitive|too repetitive|same (?:places|stops) again/.test(clause));
}
export function sampleRevision(previous: Itinerary, request: RevisionInput, excludedIds: string[]): RevisionIntent {
  const text = request.message.toLowerCase();
  const input = {...previous.input};
  const preferences: PlanPreferences = {excludeIds: [...excludedIds]};
  let understood = false;
  const clearBudget = /(?:remove|clear)(?: the| my)? budget|(?:no|without) (?:a )?budget|budget (?:removed|unset)/.test(text);
  const clearArrival = /(?:remove|clear)(?: the| my)? (?:arrival|deadline)|(?:no|without) (?:an? )?(?:arrival|deadline)/.test(text);
  if (/\b(?:not|don't|do not|never|avoid)\b/.test(text) || (/\bno\b/.test(text) && !clearBudget && !clearArrival)) {
    return {input, preferences, clarification: 'To avoid applying the opposite change in this sample, please state what you want directly, such as “less walking” or “remove the budget preference.”'};
  }
  if (request.replaceStopId) {
    if (!previous.stops.some(stop => stop.id === request.replaceStopId)) return {input, preferences, clarification: 'That stop is no longer in this plan. Choose a current stop to swap.'};
    preferences.excludeIds!.push(request.replaceStopId);
    preferences.replaceStopId = request.replaceStopId;
    understood = true;
  }
  const known = knownRevisionPreferences(previous, request.message);
  Object.assign(preferences, known);
  if (known.lessWalking || known.category) understood = true;
  if (/cheaper|cheap|low.?cost|less expensive|budget.?friendly/.test(text)) { input.budget = 'low'; understood = true; }
  if (clearBudget) { delete input.budget; understood = true; }
  if (clearArrival) { delete input.arrivalBy; understood = true; }
  else if (/arriv|venue|concert|show|\bby\b/.test(text)) {
    const match = text.match(/(?:by|before|at)\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/);
    if (match) {
      let hours = Number(match[1]);
      if (match[3]) {
        if (hours < 1 || hours > 12) return {input, preferences, clarification: 'Use an arrival time such as 19:00 or 7 pm.'};
        hours = hours % 12 + (match[3] === 'pm' ? 12 : 0);
      } else if (!match[2]) return {input, preferences, clarification: 'Which time do you mean? Use 19:00 or 7 pm so I can use the right show or arrival time.'};
      const value = `${hours.toString().padStart(2, '0')}:${match[2] ?? '00'}`;
      if (/\b(?:show|concert)\s+(?:time\s+)?(?:is|starts?|begins?|at|now|to)\b/.test(text) && !/\barriv/.test(text)) input.showTime = value;
      else input.arrivalBy = value;
      understood = true;
    }
  }
  const duration = text.match(/(?:explor(?:e|ing)|have|spend|make it)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/);
  if (duration) { input.durationMinutes = Number(duration[1]) * (/^(?:hour|hr)/.test(duration[2]!) ? 60 : 1); understood = true; }
  if (/\bstart (?:earlier|later)\b/.test(text)) return {input: previous.input, preferences: {}, clarification: 'How much time would you like to explore? I count backward from your venue-arrival time.'};
  const parsed = planInputSchema.safeParse(input);
  if (!parsed.success) return {input: previous.input, preferences: {}, clarification: parsed.error.issues[0]?.message ?? 'Please check the requested time.'};
  if (!understood) return {input, preferences, clarification: 'In this sample, I can swap a stop, find less walking, add more culture, food or outdoor stops, make it cheaper, set a show time, change your exploration duration, or set an arrival time such as “arrive by 7 pm.” Live mode supports more flexible requests.'};
  return {input: parsed.data, preferences};
}

export function placeNames(items: {name: string}[]): string {
  const list = items.map(item => item.name);
  return list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}
export function revisionSummary(previous: Itinerary | undefined, current: Itinerary): string {
  if (!previous) return `Your ${current.stops.length}-stop plan starts with ${current.stops[0]?.name}.${current.mode === 'sample' ? ' This is an illustrative New York sample.' : ''}`;
  const added = current.stops.filter(stop => !previous.stops.some(old => old.id === stop.id));
  const removed = previous.stops.filter(stop => !current.stops.some(next => next.id === stop.id));
  const bits: string[] = [];
  if (added.length === 1 && removed.length === 1) bits.push(`Swapped ${removed[0]!.name} for ${added[0]!.name}.`);
  else if (added.length) bits.push(`Try ${placeNames(added)}${removed.length ? ` in place of ${placeNames(removed)}` : ''}.`);
  else if (removed.length) bits.push(`Removed ${placeNames(removed)}; ${current.stops.length} ${current.stops.length === 1 ? 'stop remains' : 'stops remain'}.`);
  const walkingChange = Math.abs(current.totalWalkMinutes - previous.totalWalkMinutes);
  const walkingChangeLabel = `${walkingChange} ${walkingChange === 1 ? 'minute' : 'minutes'}`;
  if (current.totalWalkMinutes < previous.totalWalkMinutes) bits.push(`${walkingChangeLabel} less walking, ${current.totalWalkMinutes} minutes of walking in total.`);
  else if (current.totalWalkMinutes > previous.totalWalkMinutes) bits.push(`Estimated walking increases by ${walkingChangeLabel}, to ${current.totalWalkMinutes} minutes of walking in total.`);
  else if (added.length) bits.push(`Estimated walking: ${current.totalWalkMinutes} minutes.`);
  if (current.input.budget !== previous.input.budget) bits.push(current.input.budget ? `Budget preference: ${current.input.budget}.` : 'Removed the budget preference.');
  const window = derivePlanningWindow(current.input);
  const timingChanged = current.input.showTime !== previous.input.showTime || current.input.durationMinutes !== previous.input.durationMinutes || current.input.arrivalBy !== previous.input.arrivalBy || current.input.date !== previous.input.date;
  if (current.input.showTime !== previous.input.showTime) bits.push(`Show time: ${timeLabel(current.input.showTime)}.`);
  if (current.input.durationMinutes !== previous.input.durationMinutes) bits.push(`${current.input.durationMinutes} minutes to explore, including walking.`);
  if (current.input.arrivalBy !== previous.input.arrivalBy) bits.push(current.input.arrivalBy ? `Venue-arrival target: ${timeLabel(window.arrivalTime)}${window.arrivalDate !== current.input.date ? ` on ${window.arrivalDate}` : ''}.` : 'Venue arrival returns to 30 minutes before the show.');
  if (timingChanged) bits.push(`Start exploring at ${timeLabel(window.startTime)}${window.startDate !== current.input.date ? ` on ${window.startDate}` : ''}.`);
  return bits.length ? bits.join(' ') : `No places changed; the route stays at ${current.totalWalkMinutes} minutes of estimated walking.`;
}


export function refinementLimit(groups: (PlacePreference & {turnSearch?: boolean})[], input: PlanInput, venue: Venue, start?: StartingLocation, previous?: Itinerary, candidates: Place[] = []): string {
  const excluded = groups.filter(group => group.maximum === 0);
  const current = groups.filter(group => group.turnSearch && group.minimum > 0);
  if (!current.length && excluded.length) return `I could not find an outing that excludes ${excluded.map(group => group.query).join(' and ')} stops and fits your ${input.durationMinutes}-minute window${input.budget ? ` and ${input.budget} budget preference` : ''}. Your plan is unchanged. Allow more time or change a place preference.`;
  const requested = current.map(group => group.diningStyle ? 'fine-dining' : group.query).join(' and ') || 'matching';
  if (current.length && current.every(group => !group.ids.length)) return `I could not verify nearby ${requested} options in the available place data. Your plan is unchanged. Try a broader kind of place or a named restaurant.`;
  const priceBlocked = input.budget && current.some(group => group.ids.length && !candidates.some(place => group.ids.includes(place.id) && budgetAllows(place, input.budget)));
  if (candidates.length && priceBlocked) return `I found ${requested} options, but none has a verified price tier within your ${input.budget} budget preference. Your current plan is unchanged. Say “remove the budget preference” to consider places whose admission or prices need confirming.`;
  const kept = groups.filter(group => group.strength === 'required' && group.minimum > 0 && !group.turnSearch).map(group => `${group.minimum} ${group.query} ${group.minimum === 1 ? 'stop' : 'stops'}`).join(' and ');
  const limits = [`${input.durationMinutes}-minute outing before the ${timeLabel(input.showTime)} show`, ...(input.budget ? [`${input.budget} budget preference`] : []), ...(input.arrivalBy ? [`arrival by ${timeLabel(input.arrivalBy)}`] : [])].join(', ');
  return `I found ${requested} options, but could not fit ${previous ? `a replacement into your ${previous.stops.length}-stop plan within` : 'them into'} your ${limits} from ${start?.name ?? venue.name} to ${venue.name}${kept ? ` while keeping ${kept}` : ''}. Your plan is unchanged. Allow more time or relax a required preference to make room.`;
}
