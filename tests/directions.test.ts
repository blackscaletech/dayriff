import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, Venue } from '../src/shared/types.js';
import { directionsUrl, walkingLegUrl } from '../src/server/providers/walking.js';

const venue: Venue = {id: 'venue', name: 'Bowery Ballroom', city: 'New York', address: '6 Delancey St, New York, NY 10002', coordinates: {latitude: 40.72049, longitude: -73.99337}, website: '', timezone: 'America/New_York'};
const bookstore: Place = {id: 'bookstore', name: 'Housing Works Bookstore', address: '126 Crosby St, New York, NY 10012', coordinates: {latitude: 40.7246, longitude: -73.9969}, category: 'shop', description: '', durationMinutes: 25};

test('walking route identifies New York addresses and keeps the selected stop order', () => {
  const other = {...bookstore, id: 'second', name: 'Another nearby stop'};
  const url = new URL(directionsUrl(venue, [bookstore, other]));
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/maps/dir/');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('travelmode'), 'walking');
  assert.equal(url.searchParams.get('origin'), 'Bowery Ballroom, 6 Delancey St, New York, NY 10002, New York');
  assert.equal(url.searchParams.get('destination'), url.searchParams.get('origin'));
  const waypoints = url.searchParams.get('waypoints')!.split('|');
  assert.equal(waypoints.length, 2);
  assert.match(waypoints[0]!, /^Housing Works Bookstore, .*New York/);
  assert.match(waypoints[1]!, /^Another nearby stop, .*New York/);
});

test('Google place identities take precedence when supplied, without misaligning partial waypoint IDs', () => {
  const mappedVenue = {...venue, googlePlaceId: 'ChIJVenueExample_123'};
  const mappedBookstore = {...bookstore, googlePlaceId: 'ChIJBookstoreExample_456'};
  const url = new URL(directionsUrl(mappedVenue, [mappedBookstore]));
  assert.equal(url.searchParams.get('origin_place_id'), mappedVenue.googlePlaceId);
  assert.equal(url.searchParams.get('destination_place_id'), mappedVenue.googlePlaceId);
  assert.equal(url.searchParams.get('waypoint_place_ids'), mappedBookstore.googlePlaceId);
  const partial = new URL(directionsUrl(mappedVenue, [mappedBookstore, {...bookstore, id: 'other'}]));
  assert.equal(partial.searchParams.has('waypoint_place_ids'), false);
});

test('missing addresses use signed latitude-longitude coordinates without relying on device location', () => {
  const url = new URL(directionsUrl({...venue, address: ''}, [{...bookstore, address: ''}]));
  assert.equal(url.searchParams.get('origin'), '40.72049,-73.99337');
  assert.equal(url.searchParams.get('destination'), '40.72049,-73.99337');
  assert.equal(url.searchParams.get('waypoints'), '40.7246,-73.9969');
});

test('direct walking legs identify both endpoints without relying on waypoint support', () => {
  const from = {...bookstore, googlePlaceId: 'ChIJBookstoreExample_456'};
  const to = {...venue, googlePlaceId: 'ChIJVenueExample_123'};
  const url = new URL(walkingLegUrl(from, to, venue.city));
  assert.match(url.searchParams.get('origin')!, /^Housing Works Bookstore, .*New York/);
  assert.match(url.searchParams.get('destination')!, /^Bowery Ballroom, .*New York/);
  assert.equal(url.searchParams.get('origin_place_id'), from.googlePlaceId);
  assert.equal(url.searchParams.get('destination_place_id'), to.googlePlaceId);
  assert.equal(url.searchParams.get('travelmode'), 'walking');
  assert.equal(url.searchParams.has('waypoints'), false);
  assert.throws(() => walkingLegUrl(from, {...to, coordinates: {latitude: NaN, longitude: -73.99}}, venue.city), /location could not be verified/);
  assert.throws(() => walkingLegUrl(from, {...to, coordinates: {latitude: 25.57, longitude: -103.50}}, venue.city), /outside the supported walking area/);
});

test('invalid coordinates, remote stops, and excess mobile waypoints fail before a directions link is generated', () => {
  for (const coordinates of [{latitude: NaN, longitude: -73.99}, {latitude: 40.72, longitude: Infinity}, {latitude: 91, longitude: -73.99}]) {
    assert.throws(() => directionsUrl({...venue, coordinates}, [bookstore]), /location could not be verified/);
  }
  assert.throws(() => directionsUrl(venue, [{...bookstore, coordinates: {latitude: 25.57, longitude: -103.50}}]), /outside the supported walking area/);
  assert.throws(() => directionsUrl(venue, Array.from({length: 4}, () => bookstore)), /too many stops/);
});

test('untrusted separators cannot add waypoints and long addresses respect the Maps URL limit', () => {
  const injected = new URL(directionsUrl(venue, [{...bookstore, address: '126 Crosby St|Gomez Palacio'}]));
  assert.equal(injected.searchParams.get('waypoints')!.split('|').length, 1);
  const longAddress = `${'é'.repeat(240)}, New York`;
  const url = directionsUrl({...venue, address: longAddress}, Array.from({length: 3}, () => ({...bookstore, address: longAddress})));
  assert.ok(url.length <= 2_048);
  assert.equal(new URL(url).searchParams.get('origin'), '40.72049,-73.99337');
});
