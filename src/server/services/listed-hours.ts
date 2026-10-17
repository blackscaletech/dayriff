import type { Place } from '../../shared/types.js';
import { clockMinutes } from '../validation.js';

const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** Weekly provider hours can rule out a visit; absent days do not establish availability. */
export function listedVisitFits(place: Pick<Place, 'openingHours' | 'durationMinutes'>, date: string, arrivalMinutes: number): boolean {
  if (!place.openingHours?.length) return true;
  const dateDay = new Date(`${date}T12:00:00Z`).getUTCDay();
  const offset = Math.floor(arrivalMinutes / 1440);
  const dayAt = (day: number) => place.openingHours!.find(item => item.day === weekdays[((dateDay + day) % 7 + 7) % 7]);
  const windows: {opens: number; closes: number}[] = [];
  for (const day of [offset - 1, offset]) {
    const listed = dayAt(day);
    if (!listed || listed.closed) continue;
    for (const period of listed.periods) {
      const opens = clockMinutes(period.opens) + day * 1440;
      let closes = clockMinutes(period.closes) + day * 1440;
      if (closes <= opens) closes += 1440;
      windows.push({opens, closes});
    }
  }
  const merged: typeof windows = [];
  for (const window of windows.sort((a, b) => a.opens - b.opens)) {
    const last = merged.at(-1);
    if (last && window.opens <= last.closes) last.closes = Math.max(last.closes, window.closes);
    else merged.push({...window});
  }
  if (merged.some(window => arrivalMinutes >= window.opens && arrivalMinutes + place.durationMinutes <= window.closes)) return true;
  const listed = dayAt(offset);
  return !listed || (!listed.closed && !listed.periods.length);
}
