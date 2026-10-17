/** All clocks and dates are local to the concert venue; offsets are relative to its show date. */
export interface PlanningWindowInput { date: string; showTime: string; durationMinutes: number; arrivalBy?: string }
export interface PlanningWindow {
  startMinutes: number; arrivalMinutes: number; showMinutes: number;
  startTime: string; arrivalTime: string; showTime: string;
  startDate: string; arrivalDate: string; showDate: string; arrivalBufferMinutes: number;
}
export const DEFAULT_ARRIVAL_BUFFER_MINUTES = 30;
const DAY_MINUTES = 1440;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function clockMinutes(time: string): number {
  if (!timePattern.test(time)) throw new RangeError('Choose a valid time, such as 19:00.');
  const [hours, minutes] = time.split(':').map(Number);
  return hours! * 60 + minutes!;
}
/** Wrap across midnight for both positive and negative show-day offsets. */
export function clockTime(minutes: number): string {
  if (!Number.isFinite(minutes)) throw new RangeError('Choose a valid time.');
  const clock = ((Math.trunc(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${Math.floor(clock / 60).toString().padStart(2, '0')}:${(clock % 60).toString().padStart(2, '0')}`;
}
function calendarDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 1 || parsed.toISOString().slice(0, 10) !== date) throw new RangeError('Choose a valid show date.');
  return parsed;
}
/** Calendar arithmetic uses UTC to avoid the browser/server timezone and daylight-saving drift. */
export function dateAtMinutes(date: string, minutes: number): string {
  if (!Number.isFinite(minutes)) throw new RangeError('Choose a valid time.');
  const parsed = calendarDate(date);
  parsed.setUTCDate(parsed.getUTCDate() + Math.floor(minutes / DAY_MINUTES));
  if (parsed.getUTCFullYear() < 1 || parsed.getUTCFullYear() > 9999) throw new RangeError('Choose a show date that keeps the whole outing within a valid calendar year.');
  return parsed.toISOString().slice(0, 10);
}
export function derivePlanningWindow(input: PlanningWindowInput): PlanningWindow {
  calendarDate(input.date);
  const showMinutes = clockMinutes(input.showTime);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 30 || input.durationMinutes > 480) throw new RangeError('Choose between 30 minutes and 8 hours to explore.');
  let arrivalMinutes = showMinutes - DEFAULT_ARRIVAL_BUFFER_MINUTES;
  if (input.arrivalBy !== undefined) {
    arrivalMinutes = clockMinutes(input.arrivalBy);
    if (arrivalMinutes > showMinutes) arrivalMinutes -= DAY_MINUTES;
    if (showMinutes - arrivalMinutes > 12 * 60) throw new RangeError('Choose an arrival time before the show, no more than 12 hours earlier. For an overnight show, you can arrive the previous evening.');
  }
  const startMinutes = arrivalMinutes - input.durationMinutes;
  return {startMinutes, arrivalMinutes, showMinutes, startTime: clockTime(startMinutes), arrivalTime: clockTime(arrivalMinutes), showTime: input.showTime,
    startDate: dateAtMinutes(input.date, startMinutes), arrivalDate: dateAtMinutes(input.date, arrivalMinutes), showDate: input.date, arrivalBufferMinutes: showMinutes - arrivalMinutes};
}
