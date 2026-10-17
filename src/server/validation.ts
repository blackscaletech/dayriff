import { z } from 'zod';
import {derivePlanningWindow} from '../shared/planning-window.js';
export {clockMinutes, clockTime} from '../shared/planning-window.js';

const id = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a valid time.');
const optionalTime = z.preprocess(value => value === '' || value === null ? undefined : value, time.optional());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Choose a valid date.');
export const planInputSchema = z.object({
  // Selection images are display-only. Canonical media is recovered from the server's verified selection.
  artist: z.object({ id, name: z.string().trim().min(1).max(160), detail: z.string().max(300).optional(), image: z.unknown().optional() }).strict()
    .transform(({image: _image, ...artist}) => artist),
  venueId: id,
  date,
  showTime: time,
  durationMinutes: z.number().int().min(30).max(480),
  startingPoint: z.string().trim().max(240).transform(value => value || 'Near the venue'),
  arrivalBy: optionalTime,
  budget: z.preprocess(value => value === '' || value === null ? undefined : value, z.enum(['low', 'medium', 'high']).optional()),
}).strict().superRefine((value, context) => {
  try { derivePlanningWindow(value); } catch (error) {
    context.addIssue({code: 'custom', path: ['arrivalBy'], message: error instanceof Error ? error.message : 'Check your show and arrival times.'});
  }
});
export const revisionSchema = z.object({ message: z.string().trim().min(1).max(600), replaceStopId: id.optional() }).strict();
export const searchSchema = z.object({ q: z.string().trim().min(2).max(100) }).strict();
export const venueSearchSchema = z.object({q: z.string().trim().max(100).default(''), cityId: id.optional()}).strict().superRefine((value, context) => {
  if (!value.cityId && value.q.length < 2) context.addIssue({code: 'custom', path: ['q'], message: 'Enter a venue or city name.'});
});
export const restoreSchema = z.object({versionId: id}).strict();
export const historyDeleteParamsSchema = z.object({id: z.string().uuid(), versionId: z.string().uuid()}).strict();
export const planIdSchema = z.object({ id });
