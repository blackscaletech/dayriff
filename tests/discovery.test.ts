import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, PlanInput, Venue } from '../src/shared/types.js';
import { loadConfig } from '../src/server/config.js';
import { agentPlan } from '../src/server/providers/openai.js';
import {defaultTurnIntent as intent} from '../src/server/services/journey-intent.js';
import { findPlaces, matchesPlaceQuery } from '../src/server/providers/qloo.js';
import { checkPlan } from '../src/server/services/planner.js';

const venue: Venue = {id: 'venue', name: 'Venue', city: 'Test City', address: 'Test address', coordinates: {latitude: 40.72, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-30', showTime: '18:30', durationMinutes: 180, startingPoint: 'venue'};
const bookstoreId = '11111111-1111-1111-1111-111111111111';
const bookTag = 'urn:tag:genre:place:bookstore';
function entity(id: string, name: string, latitude = 40.721, tags = [bookTag]) {
  return {entity_id: id, name, subtype: 'urn:entity:place', location: {lat: latitude, lon: -73.991},
    tags: tags.map(tag => ({id: tag, type: 'urn:tag:genre:place', name: tag.split(':').at(-1)})),
    properties: {description: `${name} is a neighborhood stop.`, image: {url: 'https://images.qloo.com/i/example-420x-auto.jpg'}}};
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}}); }
function tool(name: string, args: unknown, sequence: number) {
  return json({output: [{type: 'function_call', name, arguments: JSON.stringify(args), call_id: `call-${sequence}`} ]});
}
test('a new follow-up discovers real subtype matches and rejects a generic shop substitution', async () => {
  const places: Place[] = [1, 2, 3].map(index => ({id: `original-${index}`, name: `Gallery ${index}`, category: 'culture', address: '',
    coordinates: {latitude: 40.72 + index * .0002, longitude: -73.99}, description: 'A small gallery', durationMinutes: 25}));
  const initial = await checkPlan({ids: places.map(place => place.id), input, venue, candidates: places, mode: 'live'});
  assert.ok(initial.itinerary);
  const originalFetch = globalThis.fetch;
  let modelCalls = 0, retrievalCalls = 0;
  globalThis.fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') {
      modelCalls++;
      if (modelCalls === 1) return tool('find_places', {query: 'bookstore', minimum_stops: 1, refine_previous_search: false}, modelCalls);
      return tool('check_plan', {stop_ids: places.map(place => place.id),
        budget_update: 'unchanged', arrival_update: 'unchanged', walking: 'unchanged', clarification: null}, modelCalls);
    }
    retrievalCalls++;
    assert.equal(url.hostname, 'api.qloo.com');
    if (url.pathname === '/v2/tags') return json({results: {tags: [{tag_id: bookTag, type: 'urn:tag:genre:place', name: 'Bookstores'}]}});
    if (url.pathname === '/entities') return json({results: [entity(bookstoreId, 'Neighborhood Books')]});
    assert.equal(url.searchParams.get('signal.interests.entities'), input.artist.id);
    assert.equal(url.searchParams.get('filter.tags'), bookTag);
    assert.equal(url.searchParams.get('filter.location'), 'POINT(-73.99 40.72)');
    return json({results: {entities: [entity(bookstoreId, 'Neighborhood Books')]}});
  };
  try {
    const result = await agentPlan({config: loadConfig({APP_MODE: 'live', QLOO_API_URL: 'https://api.qloo.com', QLOO_API_KEY: 'discovery-test-only', OPENAI_API_KEY: 'agent-test-only'}),
      input, venue, candidates: places, previous: initial.itinerary, turnIntent: intent({kind: 'adjust', placeRequests: [{query: 'bookstore', minimum: 1, strength: 'preference'}]}), request: {message: 'More bookstores please'}, messages: [], excludedIds: []});
    assert.ok(result.itinerary);
    assert.ok(result.itinerary.stops.some(stop => stop.id === bookstoreId));
    assert.equal(result.itinerary.input.budget, undefined);
    assert.equal(result.itinerary.input.arrivalBy, undefined);
    assert.equal(result.itinerary.stops.find(stop => stop.id === bookstoreId)?.image?.attribution?.[0]?.name, 'Qloo');
    assert.ok(result.candidates.length <= 40);
    assert.equal(modelCalls, 1, 'Typed subtype discovery applies a fully checked plan without another selection call');
    assert.equal(retrievalCalls, 3);
  } finally { globalThis.fetch = originalFetch; }
});
test('search fallback remains geographically scoped and reranking cannot introduce foreign IDs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.pathname === '/v2/tags') return json({results: {tags: []}});
    if (url.pathname === '/search') {
      assert.equal(url.searchParams.get('filter.location'), '40.72,-73.99');
      assert.equal(url.searchParams.get('filter.radius'), '1.55');
      return json({results: [{...entity(bookstoreId, 'Neighborhood Books'), query: {affinity: .99}}, entity('22222222-2222-2222-2222-222222222222', 'Distant Books', 42),
        entity('33333333-3333-3333-3333-333333333333', 'Unrelated Shop', 40.721, ['urn:tag:genre:place:gift_shop'])]});
    }
    assert.equal(url.searchParams.get('filter.results.entities'), bookstoreId);
    return json({results: {entities: [entity('44444444-4444-4444-4444-444444444444', 'Foreign Result')]}});
  };
  try {
    const found = await findPlaces({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'fallback-test-only'}, input.artist, venue, 'bookstore');
    assert.deepEqual(found.places.map(place => place.id), [bookstoreId]);
    assert.equal(found.usedTasteRanking, false);
    assert.equal(matchesPlaceQuery(found.places[0]!, '寿司'), false, 'Non-Latin queries must not become an empty match-all filter');
    assert.deepEqual(found.places[0]!.recommendation, {source: 'qloo_search', query: 'bookstore'});
    assert.equal(found.places[0]!.matchReason, undefined);
    assert.equal(found.places[0]!.affinity, undefined, 'A generic search score is not evidence of artist affinity');
  } finally { globalThis.fetch = originalFetch; }
});


test('ancillary restaurant tags on a museum do not satisfy dining requests', () => {
  const restaurantTag = 'urn:tag:genre:place:restaurant';
  const museum: Place = {id: 'mixed-museum', name: 'Museum of Sex', category: 'culture', address: '', coordinates: venue.coordinates,
    description: 'A museum with exhibits and a restaurant.', durationMinutes: 35, taxonomy: ['urn:tag:genre:place:museum', restaurantTag]};
  const restaurant: Place = {...museum, id: 'real-dining', name: 'Neighborhood Restaurant', category: 'food', description: 'A regional restaurant.', taxonomy: [restaurantTag]};
  const cafe: Place = {...restaurant, id: 'cafe-only', name: 'Neighborhood Cafe', description: 'A coffee and pastry cafe.', taxonomy: ['urn:tag:genre:place:cafe']};
  assert.equal(matchesPlaceQuery(museum, 'restaurant', [restaurantTag]), false);
  assert.equal(matchesPlaceQuery(restaurant, 'restaurant', [restaurantTag]), true);
  assert.equal(matchesPlaceQuery(cafe, 'restaurant', [restaurantTag]), false, 'Cafe category alone must not satisfy a precise restaurant subtype');
  assert.equal(matchesPlaceQuery(museum, 'museum', ['urn:tag:genre:place:museum']), true, 'The same museum remains eligible as a cultural stop');
});


test('focused replacement discovery finds local candidates without admitting provider results outside its target area', async () => {
  const originalFetch = globalThis.fetch;
  const start = {name: 'Local start', address: '', coordinates: {latitude: 40.70, longitude: -73.99}};
  const targetArea = {coordinates: {latitude: 40.701, longitude: -73.99}, radius: 600};
  const nearby = entity(bookstoreId, 'Nearby Books', 40.7012);
  const distant = entity('66666666-6666-4666-8666-666666666666', 'Corridor Books', 40.72);
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.pathname === '/v2/tags') return json({results: {tags: [{tag_id: bookTag, type: 'urn:tag:genre:place', name: 'Bookstore'}]}});
    assert.equal(url.pathname, '/v2/insights');
    assert.equal(url.searchParams.get('filter.location'), 'POINT(-73.99 40.701)');
    assert.equal(url.searchParams.get('filter.location.radius'), '600');
    assert.equal(url.searchParams.get('signal.interests.entities'), input.artist.id);
    return json({results: {entities: [distant, nearby]}});
  };
  try {
    const found = await findPlaces({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'focused-discovery-test'}, input.artist, venue, 'bookstore', start, {}, targetArea);
    assert.deepEqual(found.places.map(place => place.id), [bookstoreId]);
    assert.equal(found.usedTasteRanking, true);
  } finally {globalThis.fetch = originalFetch;}
});


test('canonical categories discover multiple real subtypes without literal category names', async t => {
  const cases = [
    {category: 'culture', queries: ['museum', 'art gallery'], tags: ['museum', 'art_gallery'], names: ['The Archive', 'Drawing Room']},
    {category: 'food', queries: ['restaurant', 'cafe'], tags: ['restaurant', 'cafe'], names: ['Local Table', 'Morning House']},
    {category: 'shop', queries: ['bookstore', 'record store'], tags: ['bookstore', 'record_store'], names: ['Leaf and Page', 'Needle Works']},
    {category: 'outdoors', queries: ['park', 'garden'], tags: ['park', 'garden'], names: ['Oak Haven', 'The Conservatory']},
  ] as const;
  for (const [index, current] of cases.entries()) await t.test(current.category, async () => {
    const originalFetch = globalThis.fetch;
    const tagIds = current.tags.map(tag => `urn:tag:genre:place:${tag}`);
    const ids = [1, 2].map(number => `a0000000-0000-4000-8000-${String(index * 10 + number).padStart(12, '0')}`);
    const requested: string[] = [];
    let insights = 0;
    globalThis.fetch = async resource => {
      const url = new URL(String(resource));
      assert.equal(url.hostname, 'api.qloo.com');
      if (url.pathname === '/v2/tags') {
        const query = url.searchParams.get('filter.query')!;
        requested.push(query);
        const position = current.queries.findIndex(value => value === query);
        assert.ok(position >= 0, 'Resolve genuine subtypes instead of the canonical UI label');
        return json({results: {tags: [{tag_id: tagIds[position], type: 'urn:tag:genre:place', name: query}]}});
      }
      assert.equal(url.pathname, '/v2/insights');
      insights++;
      assert.equal(url.searchParams.get('signal.interests.entities'), input.artist.id);
      assert.equal(url.searchParams.get('filter.location'), 'POINT(-73.99 40.72)');
      assert.equal(url.searchParams.get('operator.filter.tags'), 'union');
      assert.deepEqual(new Set(url.searchParams.get('filter.tags')!.split(',')), new Set(tagIds));
      const wrongTag = current.category === 'food' ? 'museum' : 'restaurant';
      return json({results: {entities: [
        ...ids.map((id, position) => ({...entity(id, current.names[position]!, 40.721, [tagIds[position]!]), properties: {description: 'An independent neighborhood place.', price_level: 1}})),
        entity('b0000000-0000-4000-8000-000000000001', 'Different Kind', 40.721, [`urn:tag:genre:place:${wrongTag}`]),
        entity('b0000000-0000-4000-8000-000000000002', 'Too Far Away', 42, [tagIds[0]!]),
      ]}});
    };
    try {
      const found = await findPlaces({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: `category-${current.category}-test`}, input.artist, venue, current.category);
      assert.equal(found.query, current.category, 'Discovery keeps the original canonical preference identity');
      assert.deepEqual(new Set(found.places.map(place => place.id)), new Set(ids));
      assert.ok(found.places.every(place => place.category === current.category && place.costTier === 1));
      assert.ok(found.places.every(place => matchesPlaceQuery(place, current.category)));
      assert.equal(found.usedTasteRanking, true);
      assert.deepEqual(new Set(requested), new Set(current.queries));
      assert.equal(insights, 1, 'Subtype tags share one artist-ranked category query');
    } finally {globalThis.fetch = originalFetch;}
  });
});

test('broad category fallback stays scoped, combines subtypes and rejects reranking category drift', async () => {
  const originalFetch = globalThis.fetch;
  const museumId = 'c0000000-0000-4000-8000-000000000001';
  const galleryId = 'c0000000-0000-4000-8000-000000000002';
  const museumTag = 'urn:tag:genre:place:museum';
  const galleryTag = 'urn:tag:genre:place:art_gallery';
  const queries: string[] = [];
  let rankingCalls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.pathname === '/v2/tags') return json({results: {tags: []}});
    if (url.pathname === '/search') {
      const query = url.searchParams.get('query')!;
      queries.push(query);
      assert.equal(url.searchParams.get('filter.location'), '40.72,-73.99');
      assert.equal(url.searchParams.get('filter.radius'), '1.55');
      const id = query === 'museum' ? museumId : galleryId;
      const tag = query === 'museum' ? museumTag : galleryTag;
      return json({results: {entities: [entity(id, query === 'museum' ? 'The Archive' : 'Drawing Room', 40.721, [tag]),
        entity('c0000000-0000-4000-8000-000000000003', 'Distant Candidate', 42, [tag]),
        entity('c0000000-0000-4000-8000-000000000004', 'Neighborhood Dining', 40.721, ['urn:tag:genre:place:restaurant'])]}});
    }
    rankingCalls++;
    assert.equal(url.pathname, '/v2/insights');
    assert.deepEqual(new Set(url.searchParams.get('filter.results.entities')!.split(',')), new Set([museumId, galleryId]));
    return json({results: {entities: [
      entity('c0000000-0000-4000-8000-000000000005', 'Foreign Result', 40.721, [museumTag]),
      entity(museumId, 'Unexpected Restaurant Metadata', 40.721, ['urn:tag:genre:place:restaurant']),
      entity(galleryId, 'Drawing Room', 40.721, [galleryTag]),
    ]}});
  };
  try {
    const found = await findPlaces({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'broad-fallback-test'}, input.artist, venue, 'culture');
    assert.deepEqual(queries, ['museum', 'art gallery']);
    assert.equal(rankingCalls, 1, 'Both subtype searches are reranked together once');
    assert.deepEqual(new Set(found.places.map(place => place.id)), new Set([museumId, galleryId]));
    assert.ok(found.places.every(place => place.category === 'culture'));
    assert.equal(found.places.find(place => place.id === museumId)!.name, 'The Archive', 'Mismatched reranking cannot replace a grounded cultural match');
    assert.equal(found.places.find(place => place.id === museumId)!.recommendation?.source, 'qloo_search');
    assert.equal(found.places.find(place => place.id === museumId)!.matchReason, undefined);
  } finally {globalThis.fetch = originalFetch;}
});
