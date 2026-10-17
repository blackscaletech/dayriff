import type { OpeningHoursDay, Place } from '../../shared/types.js';
import { cleanText, record } from './http.js';

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
function listedTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^(?:T)?((?:[01]\d|2[0-3]):[0-5]\d)(?::00)?$/.exec(value)?.[1];
}
function listedHours(value: unknown): OpeningHoursDay[] | undefined {
  const hours = record(value);
  const result: OpeningHoursDay[] = [];
  for (const day of weekdays) {
    const entries = hours[day];
    if (!Array.isArray(entries) || !entries.length || entries.length > 4) continue;
    const periods: OpeningHoursDay['periods'] = [];
    let closed = 0;
    let valid = true;
    for (const value of entries) {
      const entry = record(value);
      if (entry.closed === true && entry.opens === undefined && entry.closes === undefined) { closed++; continue; }
      const opens = listedTime(entry.opens);
      const closes = listedTime(entry.closes);
      if (entry.closed !== false || !opens || !closes) { valid = false; break; }
      periods.push({opens, closes});
    }
    // Never turn a partial or contradictory day into a claimed complete schedule.
    if (valid && (closed === entries.length || closed === 0)) result.push({day, closed: closed > 0, periods});
  }
  return result.length ? result : undefined;
}

/** Optional provider facts only: no inferred opening state or model-generated visitor information. */
export function normalizeVisitInfo(properties: Record<string, unknown>): Pick<Place, 'phone' | 'openingHours' | 'neighborhood'> {
  const rawPhone = typeof properties.phone === 'string' ? properties.phone.trim() : '';
  const digits = rawPhone.replace(/\D/g, '');
  const phone = rawPhone.length <= 40 && /^\+?[0-9 ().-]+$/.test(rawPhone) && digits.length >= 7 && digits.length <= 15 ? rawPhone : undefined;
  const openingHours = listedHours(properties.hours);
  const neighborhood = cleanText(properties.neighborhood, 100);
  return {...(phone ? {phone} : {}), ...(openingHours ? {openingHours} : {}), ...(neighborhood ? {neighborhood} : {})};
}
