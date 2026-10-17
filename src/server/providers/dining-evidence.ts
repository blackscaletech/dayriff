import {FINE_DINING_MINUTES} from '../services/visit-duration.js';
import type { DiningStyle, Itinerary, Place } from '../../shared/types.js';
import {derivePlanningWindow} from '../../shared/planning-window.js';
import {providerTags} from './provider-tags.js';

export const MICHELIN_COLLECTION = 'urn:tag:resy:collection:place:michelin_winners';
export const FINE_DINING_TAGS = ['urn:tag:category:place:fine_dining_restaurant', 'urn:tag:genre:place:restaurant:fine_dining'];
export {FINE_DINING_MINUTES} from '../services/visit-duration.js';
export interface DiningFilter { diningStyle?: DiningStyle; recognition?: 'michelin' }
export function diningEvidence(entity: Record<string, unknown>): Place['diningEvidence'] {
  const tags = new Set(providerTags(entity).map(tag => tag.id));
  const fineDining = [...FINE_DINING_TAGS, 'urn:tag:culinary_style:qloo:fine_dining', 'urn:tag:dining_option:qloo:fine_dining'].some(id => tags.has(id));
  const michelinCollection = tags.has(MICHELIN_COLLECTION);
  return fineDining || michelinCollection ? {...(fineDining ? {fineDining: true as const} : {}), ...(michelinCollection ? {michelinCollection: true as const} : {})} : undefined;
}
export function matchesDiningStyle(place: Place, style?: DiningStyle): boolean {
  return !style || (place.category === 'food' && place.diningEvidence?.fineDining === true && (style !== 'high_end' || place.costTier !== 1));
}
function clauses(message: string): string[] { return message.toLowerCase().replace(/[’‘]/g, "'").split(/[.!?;,]|\bbut\b|\band\b/); }
export function declinesMichelin(message: string): boolean {
  return clauses(message).some(clause => /\bmichelin\b/.test(clause) &&
    /\b(?:not|no|without|don't|do not)\b.{0,35}\bmichelin\b|\bmichelin\b.{0,25}(?:not needed|not required|is optional)/.test(clause));
}
export function requestsMichelin(message: string): boolean {
  return /\bmichelin\b/i.test(message) && !declinesMichelin(message);
}
export function requiresVerifiedMichelin(message: string): boolean {
  return requestsMichelin(message) && clauses(message).some(clause => /\b(?:only|must|require|strictly)\b.{0,40}\b(?:michelin|starred)\b|\bmichelin\b.{0,30}\bonly\b/.test(clause));
}
export function resolveDiningFilter(message: string, proposed: {dining_style: 'any' | 'fine_dining'; recognition: 'any' | 'michelin'}): DiningFilter {
  const recognition = !declinesMichelin(message) && (requestsMichelin(message) || proposed.recognition === 'michelin') ? 'michelin' as const : undefined;
  const declinesPremium = clauses(message).some(clause => /\b(?:regular|ordinary|casual) restaurants?\b|\b(?:not|no|without|don't|do not)\b.{0,30}\b(?:fine[ -]dining|high[ -]end|upscale|luxury)\b/.test(clause));
  const requestsPremium = clauses(message).some(clause => !/\b(?:not|no|without|don't|do not)\b/.test(clause) && /\b(?:fine[ -]dining|high[ -]end|upscale|luxury)\b/.test(clause));
  const highEnd = requestsPremium && /\b(?:high[ -]end|upscale|luxury)\b/i.test(message);
  const diningStyle = !declinesPremium && (requestsPremium || proposed.dining_style === 'fine_dining') ? highEnd ? 'high_end' as const : 'fine_dining' as const : undefined;
  return {diningStyle, recognition};
}
export function canonicalDiningQuery(query: string): string {
  const base = query.replace(/\bmichelin(?:[ -]*(?:starred?|stars?|rated|guide|winners?))?\b/gi, ' ')
    .replace(/\b(?:fine[ -]dining|high[ -]end|upscale|luxury|premium)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return !base || /^(?:restaurants?|dining|food|options?|places?|dinner)$/i.test(base) ? 'restaurant' : base;
}
export function diningMessage(itinerary: Pick<Itinerary, 'stops' | 'input'>, michelinRequested: boolean): string | undefined {
  const fineDining = itinerary.stops.some(place => place.diningEvidence?.fineDining);
  if (!fineDining && !michelinRequested) return undefined;
  const status = michelinRequested ? `I found ${fineDining ? 'a fine-dining' : 'a dining'} option; I couldn't verify current Michelin-star status.` : '';
  const allowance = fineDining ? `Dining has a ${FINE_DINING_MINUTES}-minute planning allowance; confirm meal length and reservations before booking.` : '';
  let clock = derivePlanningWindow(itinerary.input).startMinutes;
  const dateDay = new Date(`${itinerary.input.date}T12:00:00Z`).getUTCDay();
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const missingHours = itinerary.stops.flatMap(stop => {
    clock += stop.walkMinutes;
    const day = weekdays[((dateDay + Math.floor(clock / 1440)) % 7 + 7) % 7]!;
    clock += stop.durationMinutes;
    const listed = stop.openingHours?.find(item => item.day === day.toLowerCase());
    return stop.diningEvidence?.fineDining && (!listed || (!listed.closed && !listed.periods.length)) ? [`${stop.name} has no listed hours for ${day}; confirm before going.`] : [];
  });
  return [status, allowance, ...missingHours].filter(Boolean).join(' ');
}
