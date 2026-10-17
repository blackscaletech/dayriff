import type {PlanningWindow} from '../shared/planning-window';
import {timeLabel} from '../shared/format';
export {timeLabel} from '../shared/format';
export function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ''}` : `${remainder} min`;
}
export function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}
/** Add the local calendar date whenever a journey time differs from the show date. */
export function journeyTimeLabel(date: string, time: string, showDate: string) {
  return `${date !== showDate ? `${dateLabel(date)} · ` : ''}${timeLabel(time)}`;
}
export function explorationRangeLabel(window: PlanningWindow) {
  if (window.startDate === window.arrivalDate) {
    return `${window.startDate !== window.showDate ? `${dateLabel(window.startDate)} · ` : ''}${timeLabel(window.startTime)}–${timeLabel(window.arrivalTime)}`;
  }
  return `${dateLabel(window.startDate)} · ${timeLabel(window.startTime)} – ${dateLabel(window.arrivalDate)} · ${timeLabel(window.arrivalTime)}`;
}
export function externalHref(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function stopElementId(id: string) { return `place-${encodeURIComponent(id)}`; }

export function telephoneHref(value?: string): string | undefined {
  if (!value || !/^\+?[\d\s().-]{7,40}$/.test(value)) return undefined;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `tel:${value.startsWith('+') ? '+' : ''}${digits}` : undefined;
}
