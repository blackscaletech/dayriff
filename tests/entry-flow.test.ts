import assert from 'node:assert/strict';
import test from 'node:test';
import type {Place, PlanInput, Venue} from '../src/shared/types.js';
import {loadConfig} from '../src/server/config.js';
import {resolveSelectedEntities} from '../src/server/providers/selected-entities.js';
import {discoverInitialPlaces} from '../src/server/providers/initial-discovery.js';
import {agentPlan} from '../src/server/providers/openai.js';
import {ServiceError} from '../src/server/providers/http.js';

const artistId = '99999999-9999-4999-8999-999999999991';
const venueId = '99999999-9999-4999-8999-999999999992';
const bookId = '99999999-9999-4999-8999-999999999993';
const cityId = '99999999-9999-4999-8999-999999999994';
const venue: Venue = {id: venueId, name: 'Concert Hall', city: 'New York', address: 'New York, NY', coordinates: {latitude: 40.75, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: artistId, name: 'Untrusted submitted name'}, venueId, date: '2026-10-21', showTime: '21:30', durationMinutes: 180, startingPoint: 'Near the venue'};
const config = loadConfig({APP_MODE: 'live', QLOO_API_URL: 'https://api.qloo.com', QLOO_API_KEY: 'entry-flow-test', OPENAI_API_KEY: 'entry-flow-test'});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('expired-session selections recover from authoritative identities and reject a locality pretending to be a venue', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    assert.equal(url.pathname, '/entities'); calls++;
    return json({results: [{entity_id: artistId, name: 'Verified Artist', subtype: 'urn:entity:artist'}, {entity_id: venueId, name: venue.name, subtype: 'urn:entity:place', location: {lat: 40.75, lon: -73.99}, tags: [{id: 'urn:tag:category:place:concert_hall'}], properties: {address: venue.address, geocode: {city: 'New York'}}}, {entity_id: cityId, name: 'New York', subtype: 'urn:entity:locality', location: {lat: 40.75, lon: -73.99}, properties: {place: 'city'}}]});
  };
  try {
    const selected = await resolveSelectedEntities(config, input, {artists: [], venues: []});
    assert.equal(selected.artist.name, 'Verified Artist');
    assert.equal(selected.venue.id, venueId);
    assert.equal(calls, 1, 'Both missing selections use one bounded entity lookup');
    await assert.rejects(resolveSelectedEntities(config, {...input, venueId: cityId}, {artists: [selected.artist], venues: []}), (error: unknown) => error instanceof ServiceError && error.code === 'VENUE_NOT_FOUND');
  } finally {globalThis.fetch = original;}
});

test('missing affinity results fall back to geographically scoped real places with honest taste evidence', async () => {
  const original = globalThis.fetch;
  const tag = 'urn:tag:genre:place:bookstore';
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    assert.equal(url.hostname, 'api.qloo.com');
    if (url.pathname === '/v2/insights') return json({results: {entities: []}});
    if (url.pathname === '/v2/tags') return json({results: {tags: [{tag_id: tag, type: 'urn:tag:genre:place', name: 'Bookstore'}]}});
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('filter.location'), '40.75,-73.99');
    return json({results: [{entity_id: bookId, name: 'Neighborhood Bookstore', subtype: 'urn:entity:place', location: {lat: 40.7501, lon: -73.99}, tags: [{id: tag}], properties: {description: 'A bookstore specializing in neighborhood history and literature.', price_level: 1}}]});
  };
  try {
    const places = await discoverInitialPlaces({...config, qlooApiKey: 'empty-affinity-entry-test'}, input, venue);
    assert.equal(places.length, 1);
    assert.equal(places[0]!.id, bookId);
    assert.equal(places[0]!.affinity, undefined);
    assert.deepEqual(places[0]!.recommendation, {source: 'qloo_search', query: 'bookstore'});
    assert.equal(places[0]!.matchReason, undefined);
  } finally {globalThis.fetch = original;}
});

test('a fully verified live outing survives optional model failure without sample substitution', async () => {
  const original = globalThis.fetch;
  const places: Place[] = [0, 1, 2].map(index => ({id: `verified-${index}`, name: `Local Gallery ${index}`, category: 'culture', address: venue.address, coordinates: venue.coordinates, description: 'A neighborhood art gallery.', durationMinutes: 35}));
  try {
    for (const response of [() => json({error: 'unavailable'}, 503), () => json({output: []})]) {
      globalThis.fetch = async resource => {assert.equal(new URL(String(resource)).hostname, 'api.openai.com'); return response();};
      const result = await agentPlan({config, input, venue, candidates: places, messages: [], excludedIds: []});
      assert.ok(result.itinerary);
      assert.equal(result.itinerary.mode, 'live');
      assert.equal(result.itinerary.stops.length, 3);
      assert.deepEqual(result.itinerary.input, input);
      assert.ok(result.itinerary.stops.every(stop => places.some(place => place.id === stop.id)));
    }
  } finally {globalThis.fetch = original;}
});

test('a one-stop swap can discover a short different kind while retaining three stops and unaffected positions', async () => {
  const {replaceStop} = await import('../src/server/services/stop-replacement.js');
  const {checkPlan} = await import('../src/server/services/planner.js');
  const {createRevisionMemory} = await import('../src/server/services/revision-memory.js');
  const places: Place[] = [0, 1, 2].map(index => ({id: `book-${index}`, name: `Local Bookstore ${index}`, category: 'shop', address: venue.address, coordinates: venue.coordinates, description: 'A neighborhood bookstore.', taxonomy: ['urn:tag:genre:place:bookstore'], durationMinutes: 25, costTier: 1}));
  places[0]!.taxonomy = ['urn:tag:genre:place:restaurant', 'urn:tag:genre:place:restaurant:cafe', 'urn:tag:genre:place:book_store'];
  const submitted = {...input, budget: 'low' as const};
  const checked = await checkPlan({ids: places.map(place => place.id), input: submitted, venue, candidates: places, mode: 'live'});
  assert.ok(checked.itinerary);
  const memory = {...createRevisionMemory(checked.itinerary), stopCount: {minimum: 3, maximum: 3}, preferences: [{query: 'bookstore', ids: places.map(place => place.id), minimum: 3, strength: 'preference' as const}]};
  const original = globalThis.fetch; const queries: string[] = [];
  const parkTag = 'urn:tag:genre:place:park';
  const park = {entity_id: bookId, name: 'Local Historic Garden', subtype: 'urn:entity:place', location: {lat: 40.7501, lon: -73.99}, tags: [{id: parkTag}], properties: {description: 'A public garden with neighborhood history.', price_level: 1}};
  globalThis.fetch = async resource => {
    const url = new URL(String(resource)); assert.equal(url.hostname, 'api.qloo.com', 'A button swap never needs a model call');
    if (url.pathname === '/v2/tags') {const query = url.searchParams.get('filter.query')!; queries.push(query);return json({results: {tags: [{tag_id: query === 'park' ? parkTag : 'urn:tag:genre:place:bookstore', type: 'urn:tag:genre:place', name: query}]}});}
    if (url.pathname === '/v2/insights') {assert.equal(url.searchParams.get('filter.location'), 'POINT(-73.99 40.75)');assert.equal(url.searchParams.get('filter.location.radius'), '1000');}
    if (url.pathname === '/search') {assert.equal(url.searchParams.get('filter.location'), '40.75,-73.99');assert.equal(url.searchParams.get('filter.radius'), '0.62');}
    const matchingPark = url.pathname === '/entities' || url.searchParams.get('filter.tags') === parkTag;
    return json({results: {entities: matchingPark ? [park] : []}});
  };
  try {
    const result = await replaceStop({config: {...config, qlooApiKey: 'broader-swap-entry-test'}, previous: checked.itinerary, replaceStopId: places[0]!.id, candidates: places, excludedIds: [], memory});
    assert.ok(result.itinerary, result.clarification);assert.equal(result.itinerary.stops[0]!.id, bookId);
    assert.deepEqual(result.itinerary.stops.slice(1).map(stop => stop.id), places.slice(1).map(place => place.id));
    assert.deepEqual(result.itinerary.input, submitted);assert.deepEqual(result.memory.stopCount, {minimum: 3, maximum: 3});
    assert.deepEqual(queries, ['bookstore', 'park']);
  } finally {globalThis.fetch = original;}
});
