/** Shared display format for venue-local HH:mm clocks; no host timezone conversion. */
export function timeLabel(value: string): string {
  const [hour, minute] = value.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  return `${hour! % 12 || 12}:${String(minute).padStart(2, '0')} ${hour! < 12 ? 'AM' : 'PM'}`;
}
