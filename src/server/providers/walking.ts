import type { Coordinates, Venue, Place, StartingLocation } from '../../shared/types.js';
import { fetchJson, record, ServiceError } from './http.js';

export interface WalkingRoute { legs: number[]; approximate: boolean; notice?: string }
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
/** Search a bounded area along the walk from the interpreted start to the concert. */
export function walkingSearchArea(venue: Venue, start?: StartingLocation): {coordinates: Coordinates; radius: number} {
  if (!start) return {coordinates: venue.coordinates, radius: 2_500};
  const delta = ((start.coordinates.longitude - venue.coordinates.longitude + 540) % 360) - 180;
  const longitude = ((venue.coordinates.longitude + delta / 2 + 540) % 360) - 180;
  return {coordinates: {latitude: (venue.coordinates.latitude + start.coordinates.latitude) / 2, longitude},
    radius: Math.ceil(distanceMeters(venue.coordinates, start.coordinates) / 2 + 2_500)};
}
export function withinWalkingArea(venue: Venue, point: Coordinates, start?: StartingLocation): boolean {
  if (!start) return distanceMeters(venue.coordinates, point) <= 3_000;
  // At most a 5 km detour across the entire start-to-concert corridor.
  return distanceMeters(start.coordinates, point) + distanceMeters(point, venue.coordinates)
    <= distanceMeters(start.coordinates, venue.coordinates) + 5_000;
}
/** A conservative geometric estimate, not evidence of a passable pedestrian route. */
export function estimateWalkingMinutes(a: Coordinates, b: Coordinates): number {
  return Math.max(2, Math.ceil(distanceMeters(a, b) * 1.4 / 70) + 2);
}
export function estimatedLegs(venue: Venue, places: Place[], startingLocation?: StartingLocation): number[] {
  const points = [startingLocation?.coordinates ?? venue.coordinates, ...places.map(place => place.coordinates), venue.coordinates];
  return points.slice(1).map((point, index) => estimateWalkingMinutes(points[index]!, point));
}
export async function walkingRoute(venue: Venue, places: Place[], apiKey?: string, startingLocation?: StartingLocation): Promise<WalkingRoute> {
  const approximation = {legs: estimatedLegs(venue, places, startingLocation), approximate: true};
  if (!apiKey) return {...approximation, notice: 'Walking times are approximate distance-based estimates. A pedestrian route, street access, crossings, and terrain have not been verified. Check directions before setting out.'};
  const waypoint = (coordinates: Coordinates) => ({location: {latLng: coordinates}});
  try {
    const response = record(await fetchJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'routes.legs.duration'},
      body: JSON.stringify({origin: waypoint(startingLocation?.coordinates ?? venue.coordinates), destination: waypoint(venue.coordinates), intermediates: places.map(place => waypoint(place.coordinates)), travelMode: 'WALK'}),
    }, 'Walking directions', 8_000));
    const routes = response.routes;
    const legs = record(Array.isArray(routes) ? routes[0] : undefined).legs;
    if (!Array.isArray(legs) || legs.length !== places.length + 1) throw new ServiceError('Walking directions returned an unexpected response.');
    const minutes = legs.map(leg => {
      const duration = record(leg).duration;
      if (typeof duration !== 'string' || !/^\d+(?:\.\d+)?s$/.test(duration)) throw new ServiceError('Walking directions returned an unexpected response.');
      const seconds = Number(duration.slice(0, -1));
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) throw new ServiceError('Walking directions returned an unexpected response.');
      return Math.max(1, Math.ceil(seconds / 60));
    });
    return {legs: minutes, approximate: false};
  } catch {
    return {...approximation, notice: 'Walking directions are temporarily unavailable. Times are approximate distance-based estimates; the pedestrian route and street access have not been verified. Check directions before setting out.'};
  }
}
export function directionsUrl(venue: Venue, places: Place[], startingLocation?: StartingLocation): string {
  // Mobile Maps URLs support at most three waypoints. Never silently omit a stop.
  if (places.length > 3) throw new ServiceError('This walking route contains too many stops.', 502, 'INVALID_ROUTE');
  [venue, ...places, ...(startingLocation ? [startingLocation] : [])].forEach(validateMapPoint);
  if (startingLocation && distanceMeters(startingLocation.coordinates, venue.coordinates) > 8_000) throw new ServiceError('Choose a starting point within walking reach of the concert venue.', 422, 'INVALID_START');
  if (places.some(place => !withinWalkingArea(venue, place.coordinates, startingLocation))) {
    throw new ServiceError('A stop is outside the supported walking area.', 502, 'INVALID_ROUTE');
  }
  return mapDirectionsUrl(startingLocation ?? venue, venue, venue.city, places);
}

/** Direct legs work on Maps products that do not support itinerary waypoints. */
export function walkingLegUrl(from: Venue | Place | StartingLocation, to: Venue | Place | StartingLocation, city: string): string {
  [from, to].forEach(validateMapPoint);
  // A custom start and bounded corridor can span a larger walking leg.
  if (distanceMeters(from.coordinates, to.coordinates) > 16_000) {
    throw new ServiceError('A stop is outside the supported walking area.', 502, 'INVALID_ROUTE');
  }
  return mapDirectionsUrl(from, to, city);
}

type MapPoint = Pick<Place, 'name' | 'address' | 'coordinates'> & {googlePlaceId?: string; approximate?: boolean};
function validateMapPoint(point: MapPoint): void {
  const {latitude, longitude} = point.coordinates;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new ServiceError('A location could not be verified. Please choose it again.', 502, 'INVALID_LOCATION');
  }
}
function mapDirectionsUrl(from: MapPoint, to: MapPoint, cityName: string, waypoints: MapPoint[] = []): string {
  const city = locationText(cityName);
  const value = (point: MapPoint, compact = false) => {
    // Full addresses and city names remain readable in Maps. Coordinates are the
    // unambiguous fallback when a provider has not supplied an address or city.
    const address = locationText(point.address);
    if (!compact && !point.approximate && address && city && city !== 'Selected location') {
      return [...new Set([locationText(point.name), address, city].filter(Boolean))].join(', ');
    }
    return `${point.coordinates.latitude},${point.coordinates.longitude}`;
  };
  const build = (compact = false) => {
    const params = new URLSearchParams({api: '1', origin: value(from, compact), destination: value(to, compact), travelmode: 'walking'});
    const originId = mapPlaceId(from), destinationId = mapPlaceId(to);
    if (originId) params.set('origin_place_id', originId);
    if (destinationId) params.set('destination_place_id', destinationId);
    if (waypoints.length) {
      params.set('waypoints', waypoints.map(place => value(place, compact)).join('|'));
      const placeIds = waypoints.map(mapPlaceId);
      // Google requires a matching ID for every waypoint, in the same order.
      if (placeIds.every(Boolean)) params.set('waypoint_place_ids', placeIds.join('|'));
    }
    return `https://www.google.com/maps/dir/?${params}`;
  };
  const url = build();
  return url.length <= 2_048 ? url : build(true);
}

function locationText(value: string): string {
  return value.replace(/[\u0000-\u001f|]/g, ' ').replace(/\s+/g, ' ').trim();
}
function mapPlaceId(point: MapPoint): string | undefined {
  return typeof point.googlePlaceId === 'string' && /^[A-Za-z0-9_-]{10,255}$/.test(point.googlePlaceId) ? point.googlePlaceId : undefined;
}
