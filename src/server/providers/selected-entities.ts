import type {Artist, PlanInput, Venue} from '../../shared/types.js';
import {isConcertVenue} from './concert-search.js';
import {normalizeArtist, normalizeVenue, qlooRequest, type QlooConfig} from './qloo.js';
import {ServiceError} from './http.js';

/** Revalidate public IDs after a session expires; never trust submitted names or coordinates. */
export async function resolveSelectedEntities(config: QlooConfig, input: Pick<PlanInput, 'artist' | 'venueId'>, known: {artists: Artist[]; venues: Venue[]}): Promise<{artist: Artist; venue: Venue}> {
  let artist = known.artists.find(item => item.id === input.artist.id.toLowerCase());
  let venue = known.venues.find(item => item.id === input.venueId.toLowerCase());
  const missing = [...(!artist ? [input.artist.id] : []), ...(!venue ? [input.venueId] : [])];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (missing.length && missing.every(id => uuid.test(id))) {
    const records = await qlooRequest(config, '/entities', {entity_ids: [...new Set(missing.map(id => id.toLowerCase()))].sort().join(',')});
    if (!artist) artist = records.flatMap(entity => {const value = normalizeArtist(entity); return value?.id === input.artist.id.toLowerCase() ? [value] : [];})[0];
    if (!venue) venue = records.flatMap(entity => {const value = isConcertVenue(entity) ? normalizeVenue(entity) : undefined; return value?.id === input.venueId.toLowerCase() ? [value] : [];})[0];
  }
  if (!artist) throw new ServiceError('We could not verify the selected artist. Choose the artist again to continue.', 422, 'ARTIST_NOT_FOUND');
  if (!venue) throw new ServiceError('We could not verify the selected concert venue. Choose the venue again to continue.', 422, 'VENUE_NOT_FOUND');
  return {artist, venue};
}
