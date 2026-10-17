export type DateParts = {year: number; month: number; day: number};
export type ClockPeriod = 'AM' | 'PM';
const pad = (value: number) => String(value).padStart(2, '0');

export function monthLength(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}
export function dateParts(value: string): DateParts | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= monthLength(year, month) ? {year, month, day} : undefined;
}
function utcDate(parts: DateParts): Date {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}
function dateValue(date: Date): string | undefined {
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9999 ? `${String(year).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` : undefined;
}
export function todayValue(date = new Date()): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function addDays(value: string, amount: number): string | undefined {
  const parts = dateParts(value);
  if (!parts || !Number.isInteger(amount)) return undefined;
  const date = utcDate(parts);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateValue(date);
}
export function shiftMonth(value: string, amount: number): string | undefined {
  const parts = dateParts(value);
  if (!parts || !Number.isInteger(amount)) return undefined;
  const total = parts.year * 12 + parts.month - 1 + amount;
  const year = Math.floor(total / 12), month = total % 12 + 1;
  return year >= 1 && year <= 9999 ? `${String(year).padStart(4, '0')}-${pad(month)}-${pad(Math.min(parts.day, monthLength(year, month)))}` : undefined;
}
export function weekday(value: string): number {
  const parts = dateParts(value);
  return parts ? utcDate(parts).getUTCDay() : 0;
}
export function dateInRange(value: string, min?: string, max?: string): boolean {
  return Boolean(dateParts(value)) && !(min && dateParts(min) && value < min) && !(max && dateParts(max) && value > max);
}
export function dateSeed(value: string, min?: string, max?: string): string {
  let next = dateParts(value) ? value : todayValue();
  if (min && dateParts(min) && next < min) next = min;
  if (max && dateParts(max) && next > max) next = max;
  return next;
}
export function monthDays(value: string): {value?: string; day?: number; inMonth: boolean}[] {
  const first = `${value.slice(0, 7)}-01`, offset = weekday(first);
  return Array.from({length: 42}, (_, index) => {
    const next = addDays(first, index - offset), parts = next ? dateParts(next) : undefined;
    return {value: next, day: parts?.day, inMonth: next?.slice(0, 7) === first.slice(0, 7)};
  });
}
export function fullDateLabel(value: string): string {
  const parts = dateParts(value);
  return parts ? new Intl.DateTimeFormat('en', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'}).format(utcDate(parts)) : value;
}
export function monthLabel(value: string): string {
  const parts = dateParts(value);
  return parts ? new Intl.DateTimeFormat('en', {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(utcDate(parts)) : value;
}
export function timeParts(value: string): {hour: number; minute: number} | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? {hour, minute} : undefined;
}
export function twelveHour(value: string): {hour: number; minute: number; period: ClockPeriod} {
  const parts = timeParts(value) ?? {hour: 18, minute: 0};
  return {hour: parts.hour % 12 || 12, minute: parts.minute, period: parts.hour >= 12 ? 'PM' : 'AM'};
}
export function clockValue(hour: number, minute: number, period: ClockPeriod): string | undefined {
  return Number.isInteger(hour) && hour >= 1 && hour <= 12 && Number.isInteger(minute) && minute >= 0 && minute <= 59 ? `${pad(hour % 12 + (period === 'PM' ? 12 : 0))}:${pad(minute)}` : undefined;
}
export function timeInRange(value: string, min?: string, max?: string): boolean {
  if (!timeParts(value)) return false;
  const low = min && timeParts(min) ? min : undefined, high = max && timeParts(max) ? max : undefined;
  if (low && high && low > high) return value >= low || value <= high;
  return !(low && value < low) && !(high && value > high);
}
export function timeSeed(value: string, min?: string, max?: string): string {
  const next = timeParts(value) ? value : '18:00';
  return timeInRange(next, min, max) ? next : min && timeParts(min) ? min : max && timeParts(max) ? max : next;
}
