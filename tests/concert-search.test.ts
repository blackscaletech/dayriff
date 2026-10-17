import assert from 'node:assert/strict';
import test from 'node:test';
import type { City } from '../src/shared/types.js';
import { searchConcertLocations } from '../src/server/providers/concert-search.js';
import { searchVenues } from '../src/server/providers/qloo.js';

const city: City = {id: '81e61924-6cee-4ab4-93d3-282a5c784ab8', name: 'New York', region: 'New York', country: 'United States of America', coordinates: {latitude: 40.66, longitude: -73.94}};
const hallId = '11111111-1111-1111-1111-111111111111';
const foreignId = '22222222-2222-2222-2222-222222222222';
const otherId = '33333333-3333-3333-3333-333333333333';
const liveMusic = 'urn:tag:category:place:live_music_venue';
function venue(id: string, name: string, tags = [liveMusic]) {
  return {entity_id: id, name, types: ['urn:entity:place'], location: {lat: 40.72, lon: -73.99}, tags: tags.map(tag_id => ({tag_id, type: tag_id.split(':').slice(0, 4).join(':')})), properties: {address: '6 Delancey St, New York, NY', geocode: {city: 'New York'}}};
}
function locality(id: string, name: string, place: string) {
  return {entity_id: id, name, types: ['urn:entity:locality'], location: {lat: 40.66, lon: -73.94}, properties: {place, ancestors: [{name: 'New York', place: 'state'}, {name: 'United States of America', place: 'country'}]}};
}
function json(results: unknown): Response { return new Response(JSON.stringify({results}), {headers: {'Content-Type': 'application/json'}}); }

test('a city search returns verified city geography instead of worldwide namesake businesses', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource)); calls++;
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('types'), 'urn:entity:locality');
    return json([locality(foreignId, 'New York', 'state'), locality(otherId, 'New York County', 'county'), locality(city.id, 'New York', 'city'),
      locality(hallId, 'New York', 'neighbourhood'), {...locality(otherId, 'Bad City', 'city'), location: {lat: 200, lon: 0}}]);
  };
  try {
    const found = await searchConcertLocations({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'city-test-only'}, 'new york');
    assert.deepEqual(found, {cities: [city], venues: []});
    assert.equal(calls, 1, 'An exact city query should not fetch similarly named businesses');
  } finally { globalThis.fetch = originalFetch; }
});

test('city browsing requests the real locality polygon and only accepts concert taxonomy', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    assert.equal(url.pathname, '/v2/insights');
    assert.equal(url.searchParams.get('filter.location'), city.id);
    assert.equal(url.searchParams.get('filter.location.radius'), '0');
    assert.match(url.searchParams.get('filter.tags')!, /category:place:live_music_venue/);
    assert.equal(url.searchParams.get('operator.filter.tags'), 'union');
    return json({entities: [venue(hallId, 'Concert Hall'), venue(foreignId, 'New York Restaurant', ['urn:tag:category:place:restaurant']),
      venue(otherId, 'Ambient concert hall', ['urn:tag:amenity:qloo:concert_hall']), {...venue('invalid-id', 'Untrusted Hall')}]});
  };
  try {
    const found = await searchConcertLocations({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'city-browse-test-only'}, '', city);
    assert.deepEqual(found.cities, []);
    assert.deepEqual(found.venues.map(item => item.id), [hallId]);
    assert.equal(found.venues[0]!.city, 'New York');
    assert.equal(found.venues[0]!.timezone, 'America/New_York');
  } finally { globalThis.fetch = originalFetch; }
});

test('a typed venue is name-matched and cannot escape the selected city or inject new insight IDs', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource)); calls++;
    if (url.pathname === '/search') {
      assert.equal(url.searchParams.get('filter.location'), '40.66,-73.94');
      assert.equal(url.searchParams.get('types'), 'urn:entity:place');
      assert.ok(url.searchParams.has('filter.tags'));
      return json([venue(hallId, 'The Bowery Ballroom'), venue(foreignId, 'Bowery Hall'), venue(otherId, 'Unrelated Theater')]);
    }
    assert.equal(url.pathname, '/v2/insights');
    assert.equal(url.searchParams.get('filter.location'), city.id);
    assert.equal(url.searchParams.get('filter.location.radius'), '0');
    assert.equal(url.searchParams.get('filter.results.entities'), `${hallId},${foreignId}`);
    return json({entities: [venue(hallId, 'The Bowery Ballroom'), venue(otherId, 'Injected Bowery Venue')]});
  };
  try {
    const found = await searchConcertLocations({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'city-boundary-test-only'}, 'Bowery', city);
    assert.deepEqual(found.venues.map(item => item.id), [hallId]);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('ordinary place lookup remains available for starting-point addresses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    assert.equal(url.searchParams.get('filter.tags'), null);
    return json([venue(hallId, 'Neighborhood Bookstore', ['urn:tag:category:place:bookstore'])]);
  };
  try {
    const found = await searchVenues({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'address-lookup-test-only'}, '126 Crosby Street');
    assert.equal(found[0]?.name, 'Neighborhood Bookstore');
  } finally { globalThis.fetch = originalFetch; }
});
