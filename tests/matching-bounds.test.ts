import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type {Category, Place, PlanInput, Venue} from '../src/shared/types.js';
import {loadConfig} from '../src/server/config.js';
import {agentPlan} from '../src/server/providers/openai.js';
import {checkPlan} from '../src/server/services/planner.js';
import {defaultTurnIntent, applyPlaceScope, validateTurnIntent} from '../src/server/services/journey-intent.js';
import {createRevisionMemory, rememberPlan} from '../src/server/services/revision-memory.js';
import {capturePlan} from '../src/server/services/plan-history.js';
import {registerRoutes, type SessionState} from '../src/server/routes.js';

const venue: Venue = {id: 'venue', name: 'Concert', city: 'New York', address: '', coordinates: {latitude: 40.75, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-22', showTime: '19:00', durationMinutes: 360, startingPoint: 'SoHo', budget: 'low'};
const config = loadConfig({APP_MODE: 'live', OPENAI_API_KEY: 'offline-only', QLOO_API_KEY: 'bounds-offline', QLOO_API_URL: 'https://api.qloo.com'});
function place(id: string, category: Category, kind = category === 'food' ? 'restaurant' : category === 'shop' ? 'bookstore' : 'art_gallery'): Place {
  return {id, name: `Local ${id}`, category, address: '', coordinates: venue.coordinates, description: `An independent ${kind}.`, taxonomy: [`urn:tag:genre:place:${kind}`], costTier: 1, durationMinutes: 25};
}
async function fixture(candidates: Place[]) {
  const checked = await checkPlan({ids: candidates.slice(0, 3).map(stop => stop.id), input, venue, candidates, mode: 'live'});
  assert.ok(checked.itinerary, checked.issues.join(' '));
  return checked.itinerary;
}
const excludeRestaurants = {query: 'restaurant', category: 'food' as const, scope: 'plan' as const, minimum: 0, maximum: 0, strength: 'required' as const};

test('zero matching bounds are closed and negative requirements survive positive taste resets until explicitly withdrawn', () => {
  const preference = {...excludeRestaurants, ids: ['restaurant']};
  const context = {message: 'Typed matching bounds', currentCount: 3, trustedPlaceIds: [], preferences: [preference]};
  for (const request of [{minimum: 0}, {minimum: 2, maximum: 1}, {minimum: 0, maximum: -1}, {minimum: 0, maximum: 4}, {minimum: 0, maximum: .5}]) {
    const checked = validateTurnIntent(defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'food', strength: 'required', ...request}]}), context);
    assert.equal(checked.kind, 'clarify');
  }
  for (const placeScope of ['any', 'reset'] as const) {
    const intent = defaultTurnIntent({kind: 'adjust', placeScope});
    assert.equal(applyPlaceScope([preference], intent)[0]!.maximum, 0);
    assert.deepEqual(applyPlaceScope([preference], {...intent, dropPreferences: ['restaurant']}), []);
  }
});

test('a no-restaurant goal and positive culture minimum are enforced together and retained in memory', async () => {
  const candidates = [place('restaurant-a', 'food'), place('restaurant-b', 'food'), place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('bookshop', 'shop')];
  const previous = await fixture(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous, [], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Cached candidates already satisfy both matching bounds');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, messages: [], excludedIds: [], request: {message: 'No restaurants; keep at least two cultural stops'},
      turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [excludeRestaurants, {query: 'culture', category: 'culture', scope: 'plan', minimum: 2, strength: 'required'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.equal(result.itinerary.stops.length, 3);
    assert.ok(result.itinerary.stops.every(stop => stop.category !== 'food'));
    assert.equal(result.itinerary.stops.filter(stop => stop.category === 'culture').length, 2);
    assert.equal(result.memory.preferences.find(group => group.query === 'restaurant')!.maximum, 0);
    assert.match(result.message!, /excludes restaurant stops/);
    assert.deepEqual(result.itinerary.input, input);
    const invalid = await checkPlan({ids: ['restaurant-a', 'gallery-a', 'gallery-b'], input, venue, candidates, mode: 'live', preferences: {requiredPlaceGroups: [{ids: ['restaurant-a', 'restaurant-b'], minimum: 0, maximum: 0}]}});
    assert.equal(invalid.itinerary, undefined, 'Final validation independently rejects a proposal violating the upper bound');
    const atMostOne = await checkPlan({ids: ['restaurant-a', 'restaurant-b', 'gallery-a'], input, venue, candidates, mode: 'live', preferences: {requiredPlaceGroups: [{ids: ['restaurant-a', 'restaurant-b'], minimum: 0, maximum: 1}]}});
    assert.equal(atMostOne.itinerary, undefined);
  } finally {globalThis.fetch = original;}
});

test('later discovery refreshes an exclusion against new matching IDs while permitting a different food subtype', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('bookshop', 'shop')];
  const previous = await fixture(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous, [{...excludeRestaurants, ids: []}], undefined, {minimum: 3, maximum: 3});
  const restaurantId = 'f0000000-0000-4000-8000-000000000001', cafeId = 'f0000000-0000-4000-8000-000000000002';
  const entity = (id: string, kind: string) => ({entity_id: id, name: `Local ${kind}`, subtype: 'urn:entity:place', location: {lat: 40.75, lon: -73.99},
    tags: [{id: `urn:tag:genre:place:${kind}`, type: 'urn:tag:genre:place'}], properties: {description: `An independent neighborhood ${kind}.`, price_level: 1}});
  const restaurant = entity(restaurantId, 'restaurant'), cafe = entity(cafeId, 'cafe');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') {
      calls++;
      return new Response(JSON.stringify({output: [{type: 'function_call', name: 'find_places', call_id: `food-${calls}`, arguments: JSON.stringify({query: 'food', preference_query: 'food'})}]}));
    }
    if (url.pathname === '/v2/tags') {const query = url.searchParams.get('filter.query')!; return new Response(JSON.stringify({results: {tags: [{tag_id: `urn:tag:genre:place:${query}`, type: 'urn:tag:genre:place', name: query}]}}));}
    return new Response(JSON.stringify({results: {entities: url.pathname === '/entities' ? [cafe] : [restaurant, cafe]}}));
  };
  try {
    const result = await agentPlan({config: {...config, qlooApiKey: 'negative-fresh-ids'}, input, venue, candidates, previous, memory, messages: [], excludedIds: [], request: {message: 'More food, still no restaurants'},
      turnIntent: defaultTurnIntent({kind: 'adjust', placeScope: 'any', placeRequests: [{query: 'food', category: 'food', scope: 'plan', minimum: 1, operation: 'increase', strength: 'preference'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.ok(result.candidates.some(stop => stop.id === restaurantId), 'The fresh rejected kind really entered the trusted pool');
    assert.ok(result.itinerary.stops.some(stop => stop.id === cafeId));
    assert.ok(!result.itinerary.stops.some(stop => stop.id === restaurantId));
    const exclusion = result.memory.preferences.find(group => group.query === 'restaurant')!;
    assert.equal(exclusion.maximum, 0);
    assert.ok(exclusion.ids.includes(restaurantId), 'Matching evidence is refreshed rather than banning only the old IDs');
    assert.equal(calls, 1);
  } finally {globalThis.fetch = original;}
});

test('replacement-only avoidance does not ban the same kind elsewhere or in later turns', async () => {
  const candidates = [place('target', 'food'), place('keep-a', 'food'), place('keep-b', 'food'), place('new-gallery', 'culture'), place('future-restaurant', 'food')];
  const previous = await fixture(candidates), original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Both scoped turns fit cached places');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, messages: [], excludedIds: [], request: {message: 'Replace first with something that is not a restaurant'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: 'target', placeRequests: [{...excludeRestaurants, scope: 'replacement'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['new-gallery', 'keep-a', 'keep-b']);
    assert.ok(!result.memory.preferences.some(group => group.maximum === 0), 'Slot-only bounds do not become persistent whole-plan exclusions');
    const next = await agentPlan({config, input, venue, candidates: result.candidates, previous: result.itinerary, memory: result.memory, messages: [], excludedIds: result.excludedIds, request: {message: 'More food'},
      turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'food', category: 'food', scope: 'plan', minimum: 1, operation: 'increase', strength: 'preference'}]})});
    assert.ok(next.itinerary, next.clarification);
    assert.ok(next.itinerary.stops.every(stop => stop.category === 'food'));
  } finally {globalThis.fetch = original;}
});

test('explicit reversal removes a negative bound and trusted history restores it without provider calls', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('bookshop', 'shop'), place('restaurant', 'food')];
  const previous = await fixture(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous, [{...excludeRestaurants, ids: ['restaurant']}], undefined, {minimum: 3, maximum: 3});
  const snapshot = capturePlan(previous, memory, []), original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Cached reversal and owned snapshot restoration never call providers');};
  const app = Fastify();
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, messages: [], excludedIds: [], request: {message: 'Restaurants are okay now; include one'},
      turnIntent: defaultTurnIntent({kind: 'adjust', dropPreferences: ['restaurant'], placeRequests: [{query: 'restaurant', category: 'food', scope: 'plan', minimum: 1, strength: 'required'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.ok(result.itinerary.stops.some(stop => stop.id === 'restaurant'));
    assert.equal(result.memory.preferences.find(group => group.query === 'restaurant')!.maximum, undefined);
    const state: SessionState = {itinerary: result.itinerary, candidates: result.candidates, memory: result.memory, history: [snapshot], excludedIds: [], messages: [], artists: [], venues: [], cities: []};
    await registerRoutes(app, {config, getSession: () => state});
    const restored = await app.inject({method: 'POST', url: `/api/plans/${previous.id}/restore`, payload: {versionId: snapshot.id}});
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(state.memory!.preferences.find(group => group.query === 'restaurant')!.maximum, 0);
    assert.ok(state.itinerary!.stops.every(stop => stop.id !== 'restaurant'));
    assert.equal(snapshot.preferences[0]!.maximum, 0);
  } finally {globalThis.fetch = original; await app.close();}
});


test('the same kind can be required in the plan and excluded only from the replacement slot', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('gallery-c', 'culture'), place('new-cafe', 'food', 'cafe')];
  const previous = await fixture(candidates), original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Different scoped bounds already fit the local pool');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, messages: [], excludedIds: [], request: {message: 'Replace first with something noncultural, while keeping two cultural stops'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: previous.stops[0]!.id, placeRequests: [
        {query: 'culture', category: 'culture', scope: 'replacement', minimum: 0, maximum: 0, strength: 'required'},
        {query: 'culture', category: 'culture', scope: 'plan', minimum: 2, strength: 'required'},
      ]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['new-cafe', 'gallery-b', 'gallery-c']);
    assert.equal(result.memory.preferences.length, 1);
    assert.equal(result.memory.preferences[0]!.minimum, 2);
    assert.equal(result.memory.preferences[0]!.maximum, undefined, 'The replacement-only maximum cannot be merged into the persisted plan minimum');
    assert.deepEqual(result.itinerary.input, input);
  } finally {globalThis.fetch = original;}
});
