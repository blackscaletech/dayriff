import {randomBytes} from 'node:crypto';
import {placeImages} from '../../shared/place-images.js';
import type {Itinerary, Stop} from '../../shared/types.js';
import {SHARED_TRIP_RETENTION_DAYS, type SharedTrip, type ShareLink} from '../../shared/sharing.js';
import type {SessionState} from '../routes.js';
import type {StateStore} from '../storage/index.js';
import {ServiceError} from '../errors.js';
import {walkingLegUrl} from '../providers/walking.js';

export const MAX_ACTIVE_SHARES = 8;
const DAY = 86_400_000;
export interface SharedTripSnapshot {token: string; planId: string; revision: number; expiresAt: number; itinerary: Itinerary}
interface SharePointer {ownerId: string}
interface OwnerRecord {state: Pick<SessionState, 'shares'>}
const shareKey = (token: string) => `share:${token}`;
function unavailable(): never {throw new ServiceError('This shared plan is no longer available. Ask your friend for a new link.', 404, 'SHARE_NOT_FOUND');}
function publicDirections(plan: Itinerary, stops: Stop[]): string {
  const url = new URL(walkingLegUrl(stops[0]!, plan.venue, plan.venue.city));
  const waypoints = stops.slice(1);
  if (waypoints.length) {
    url.searchParams.set('waypoints', waypoints.map(stop => `${stop.coordinates.latitude},${stop.coordinates.longitude}`).join('|'));
    const ids = waypoints.map(stop => stop.googlePlaceId);
    if (ids.every(id => id && /^[A-Za-z0-9_-]{10,255}$/.test(id))) url.searchParams.set('waypoint_place_ids', ids.join('|'));
  }
  if (url.toString().length > 2_048) {
    url.searchParams.set('origin', `${stops[0]!.coordinates.latitude},${stops[0]!.coordinates.longitude}`);
    url.searchParams.set('destination', `${plan.venue.coordinates.latitude},${plan.venue.coordinates.longitude}`);
  }
  return url.toString();
}

/** Explicit public fields keep new private properties out of previously written projections. */
export function publicTrip(plan: Itinerary, token: string): Itinerary {
  const first = plan.stops[0];
  if (!first) throw new ServiceError('Add a stop before sharing this trip.', 422, 'NO_STOPS');
  const artist = {id: plan.input.artist.id, name: plan.input.artist.name, ...(plan.input.artist.image ? {image: structuredClone(plan.input.artist.image)} : {})};
  const venue = {id: plan.venue.id, name: plan.venue.name, city: plan.venue.city, address: plan.venue.address,
    coordinates: {...plan.venue.coordinates}, website: plan.venue.website, timezone: plan.venue.timezone,
    ...(plan.venue.googlePlaceId ? {googlePlaceId: plan.venue.googlePlaceId} : {}), ...(plan.venue.image ? {image: structuredClone(plan.venue.image)} : {})};
  const stops: Stop[] = plan.stops.map((stop, index) => ({id: stop.id, name: stop.name, category: stop.category, address: stop.address,
    coordinates: {...stop.coordinates}, description: stop.description, durationMinutes: stop.durationMinutes,
    arrivalTime: stop.arrivalTime, departureTime: stop.departureTime, arrivalDate: stop.arrivalDate, departureDate: stop.departureDate,
    walkMinutes: index === 0 ? 0 : stop.walkMinutes, reason: '',
    ...(stop.phone ? {phone: stop.phone} : {}), ...(stop.openingHours ? {openingHours: structuredClone(stop.openingHours)} : {}),
    ...(stop.neighborhood ? {neighborhood: stop.neighborhood} : {}), ...(stop.source ? {source: structuredClone(stop.source)} : {}),
    ...(stop.costTier ? {costTier: stop.costTier} : {}), ...(stop.googlePlaceId ? {googlePlaceId: stop.googlePlaceId} : {}),
    ...(stop.image ? {image: structuredClone(stop.image)} : {}),
    ...(stop.images?.length ? {images: placeImages(stop).map(image => ({url: image.url, alt: image.alt,
      ...(image.attribution?.length ? {attribution: image.attribution.map(credit => ({name: credit.name, ...(credit.url ? {url: credit.url} : {})}))} : {})}))} : {}),
    ...(index > 0 ? {directionsUrl: walkingLegUrl(plan.stops[index - 1]!, stop, venue.city)} : {}),
  }));
  // The private first leg is removed from both routing and summary arithmetic.
  const firstWalk = first.walkMinutes;
  const totalMinutes = Math.max(0, plan.totalMinutes - firstWalk);
  const startingLocation = {id: first.id, name: first.name, address: first.address, coordinates: {...first.coordinates},
    ...(first.googlePlaceId ? {googlePlaceId: first.googlePlaceId} : {})};
  return {id: token, mode: plan.mode, input: {artist, venueId: venue.id, date: plan.input.date, showTime: plan.input.showTime,
    durationMinutes: totalMinutes, startingPoint: first.name}, venue, startingLocation, stops,
    totalWalkMinutes: Math.max(0, plan.totalWalkMinutes - firstWalk), totalMinutes,
    estimatedArrival: plan.estimatedArrival, estimatedArrivalDate: plan.estimatedArrivalDate,
    routeUrl: publicDirections(plan, stops),
    venueDirectionsUrl: walkingLegUrl(stops[stops.length - 1]!, venue, venue.city), notices: [], revision: 0};
}

export function createSharedTrips(store: StateStore) {
  return {
    async publish(state: SessionState, ownerId: string): Promise<ShareLink> {
      const plan = state.itinerary;
      if (!plan) throw new ServiceError('Create your plan before sharing it.', 404, 'PLAN_NOT_FOUND');
      const now = Date.now();
      const active = (state.shares ?? []).filter(share => share.expiresAt > now);
      const existing = active.find(share => share.planId === plan.id && share.revision === plan.revision);
      if (existing) return {shareId: existing.token, path: `/shared/${existing.token}`, expiresAt: new Date(existing.expiresAt).toISOString()};
      if (active.length >= MAX_ACTIVE_SHARES) throw new ServiceError('You have eight active shared versions. Existing links work for seven days; try again when one expires.', 409, 'SHARE_LIMIT');
      const token = randomBytes(32).toString('base64url'), expiresAt = now + SHARED_TRIP_RETENTION_DAYS * DAY;
      const snapshot: SharedTripSnapshot = {token, planId: plan.id, revision: plan.revision, expiresAt, itinerary: publicTrip(plan, token)};
      // The pointer has no trip content. Writing it before the leased session commit
      // can leave only an unusable pointer if Clear trip or another writer wins.
      await store.transact<SharePointer, void>(shareKey(token), current => {
        if (current) throw new ServiceError('This link could not be prepared. Please try again.', 503, 'SHARE_UNAVAILABLE');
        return {record: {value: {ownerId}, expiresAt}, result: undefined};
      });
      state.shares = [...active, snapshot];
      return {shareId: token, path: `/shared/${token}`, expiresAt: new Date(expiresAt).toISOString()};
    },
    async read(token: string): Promise<SharedTrip> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) unavailable();
      const pointer = await store.read<SharePointer>(shareKey(token));
      if (!pointer || !/^[A-Za-z0-9_-]{43}$/.test(pointer.ownerId)) unavailable();
      const owner = await store.read<OwnerRecord>(`session:${pointer.ownerId}`);
      const snapshot = owner?.state.shares?.find(share => share.token === token && share.expiresAt > Date.now());
      if (!snapshot) unavailable();
      return {itinerary: structuredClone(snapshot.itinerary), expiresAt: new Date(snapshot.expiresAt).toISOString()};
    },
  };
}
