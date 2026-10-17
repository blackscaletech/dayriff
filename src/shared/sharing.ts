import type {Itinerary} from './types.js';

export const SHARED_TRIP_RETENTION_DAYS = 7;
export interface ShareLink {shareId: string; path: string; expiresAt: string}
/** A public, immutable projection. Chat, preferences and the private origin are absent. */
export interface SharedTrip {itinerary: Itinerary; expiresAt: string}
