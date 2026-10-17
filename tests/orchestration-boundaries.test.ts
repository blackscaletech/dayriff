import assert from 'node:assert/strict';
import test from 'node:test';
import type {Category, Place, PlanInput, Venue} from '../src/shared/types.js';
import {loadConfig} from '../src/server/config.js';
import {agentPlan} from '../src/server/providers/openai.js';
import {FINE_DINING_TAGS} from '../src/server/providers/dining-evidence.js';
import {checkPlan} from '../src/server/services/planner.js';
import {defaultTurnIntent} from '../src/server/services/journey-intent.js';
import {createRevisionMemory, rememberPlan} from '../src/server/services/revision-memory.js';

const venue: Venue = {id: 'venue', name: 'Concert', city: 'New York', address: '', coordinates: {latitude: 40.75, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-22', showTime: '19:00', durationMinutes: 360, startingPoint: 'SoHo', budget: 'high'};
const config = loadConfig({APP_MODE: 'live', OPENAI_API_KEY: 'offline-only', QLOO_API_KEY: 'boundary-tests', QLOO_API_URL: 'https://api.qloo.com'});
const tags: Record<Category, string> = {culture: 'art_gallery', food: 'restaurant', shop: 'bookstore', outdoors: 'park'};
function place(id: string, category: Category): Place {return {id, name: `Local ${id}`, category, address: 'New York', coordinates: venue.coordinates,
  description: `An independent neighborhood ${tags[category]}.`, taxonomy: [`urn:tag:genre:place:${tags[category]}`], durationMinutes: 25, costTier: 1};}
async function fixture(candidates: Place[]) {
  const checked = await checkPlan({ids: candidates.slice(0, 3).map(stop => stop.id), input, venue, candidates, mode: 'live'});
  assert.ok(checked.itinerary, checked.issues.join(' '));
  return checked.itinerary;
}
const json = (value: unknown) => new Response(JSON.stringify(value));
const searchCall = (query: string, sequence: number) => json({output: [{type: 'function_call', name: 'find_places', call_id: `search-${sequence}`, arguments: JSON.stringify({query, preference_query: query})}]});

test('exclusive replacement scope constrains the new place without narrowing every retained stop', async () => {
  const candidates = [place('target', 'culture'), place('keep-food', 'food'), place('keep-shop', 'shop'), {...place('new-cafe', 'food'), taxonomy: ['urn:tag:genre:place:cafe']}];
  const previous = await fixture(candidates);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('The scoped replacement is already available');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, messages: [], excludedIds: [], request: {message: 'Replace the first stop only with a café and keep the others'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: 'target', placeRequests: [{query: 'cafe', category: 'food', scope: 'replacement', minimum: 1, strength: 'required', exclusive: true}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['new-cafe', 'keep-food', 'keep-shop']);
    assert.ok(!result.memory.preferences.some(group => group.query === 'cafe'), 'Replacement-only bounds cannot become a persistent whole-route restriction');
    assert.deepEqual(result.itinerary.input, input);
  } finally {globalThis.fetch = original;}
});

test('same-query discovery binds the unsatisfied replacement facet rather than an already satisfied general type', async () => {
  const candidates = [place('target', 'culture'), place('keep-food', 'food'), place('keep-shop', 'shop')];
  const previous = await fixture(candidates);
  const restaurantTag = 'urn:tag:genre:place:restaurant';
  const fineId = 'e0000000-0000-4000-8000-000000000001';
  const fine = {entity_id: fineId, name: 'Seasonal Tasting Room', subtype: 'urn:entity:place', location: {lat: 40.75, lon: -73.99},
    tags: [restaurantTag, FINE_DINING_TAGS[0]!].map(id => ({id, type: 'urn:tag:genre:place'})), properties: {description: 'A fine-dining restaurant with a seasonal tasting menu.', price_level: 3}};
  const original = globalThis.fetch;
  let calls = 0, fineSearches = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') return searchCall('restaurant', ++calls);
    if (url.pathname === '/v2/tags') return json({results: {tags: [{tag_id: restaurantTag, type: 'urn:tag:genre:place', name: 'Restaurant'}]}});
    if (url.pathname === '/entities') return json({results: {entities: [fine]}});
    assert.ok(url.searchParams.get('filter.tags')?.includes(FINE_DINING_TAGS[0]!), 'Discovery must carry the unsatisfied fine-dining facet');
    fineSearches++;
    return json({results: {entities: [fine]}});
  };
  try {
    const result = await agentPlan({config: {...config, qlooApiKey: 'scoped-facets-success'}, input, venue, candidates, previous, messages: [], excludedIds: [],
      request: {message: 'Replace first with fine dining and keep a restaurant in the whole plan'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: 'target', placeRequests: [
        {query: 'restaurant', category: 'food', scope: 'plan', minimum: 1, strength: 'required'},
        {query: 'restaurant', category: 'food', scope: 'replacement', diningStyle: 'fine_dining', minimum: 1, strength: 'preference'},
      ]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), [fineId, 'keep-food', 'keep-shop']);
    assert.equal(result.itinerary.stops[0]!.durationMinutes, 90);
    assert.ok(result.itinerary.stops[0]!.diningEvidence?.fineDining);
    assert.equal(calls, 1, 'Correct facet binding avoids a redundant second execution call');
    assert.equal(fineSearches, 1);
  } finally {globalThis.fetch = original;}
});

test('two unresolved same-query facets share the bounded searches without repeating the general facet', async () => {
  const candidates = [place('target', 'culture'), place('keep-food-a', 'food'), place('keep-food-b', 'food')];
  const previous = await fixture(candidates), memory = createRevisionMemory(previous), snapshot = structuredClone(memory);
  const original = globalThis.fetch;
  const filters: string[] = [];
  let calls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') return searchCall('restaurant', ++calls);
    if (url.pathname === '/v2/tags') return json({results: {tags: [{tag_id: 'urn:tag:genre:place:restaurant', type: 'urn:tag:genre:place', name: 'Restaurant'}]}});
    if (url.pathname === '/v2/insights') filters.push(url.searchParams.get('filter.tags')!);
    return json({results: {entities: []}});
  };
  try {
    const result = await agentPlan({config: {...config, qlooApiKey: 'scoped-facets-failure'}, input, venue, candidates, previous, memory, messages: [], excludedIds: [],
      request: {message: 'Replace first with fine dining and make all three stops restaurants'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: 'target', placeRequests: [
        {query: 'restaurant', category: 'food', scope: 'plan', minimum: 3, strength: 'required'},
        {query: 'restaurant', category: 'food', scope: 'replacement', diningStyle: 'fine_dining', minimum: 1, strength: 'preference'},
      ]})});
    assert.equal(result.itinerary, undefined);
    assert.equal(calls, 2);
    assert.ok(filters[0]?.includes(FINE_DINING_TAGS[0]!));
    assert.equal(filters[1], 'urn:tag:genre:place:restaurant');
    assert.deepEqual(result.memory, snapshot);
    assert.deepEqual(result.excludedIds, []);
  } finally {globalThis.fetch = original;}
});

test('explicit preference withdrawal does not erase unrelated required tastes or submitted settings', async () => {
  const candidates = [place('book-a', 'shop'), place('book-b', 'shop'), place('gallery', 'culture'), place('cafe', 'food')];
  const previous = await fixture(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous, [
    {query: 'bookstore', category: 'shop', minimum: 1, strength: 'required', ids: ['book-a', 'book-b']},
    {query: 'culture', category: 'culture', minimum: 1, strength: 'required', ids: ['gallery']},
  ], undefined, {minimum: 3, maximum: 3});
  const snapshot = structuredClone(memory), original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('A typed withdrawal needs no outside call');};
  try {
    const kept = await agentPlan({config, input, venue, candidates, previous, memory, messages: [], excludedIds: ['blocked'], request: {message: 'Do not remove the bookstores'},
      turnIntent: defaultTurnIntent({kind: 'adjust', keepPreferences: ['bookstore']})});
    assert.ok(kept.itinerary, kept.clarification);
    assert.equal(kept.memory.preferences.find(group => group.query === 'bookstore')!.minimum, 2);
    const dropped = await agentPlan({config, input, venue, candidates, previous, memory, messages: [], excludedIds: ['blocked'], request: {message: 'I no longer require bookstores; keep the culture preference'},
      turnIntent: defaultTurnIntent({kind: 'adjust', dropPreferences: ['bookstore'], keepPreferences: ['culture']})});
    assert.ok(dropped.itinerary, dropped.clarification);
    assert.deepEqual(dropped.memory.preferences.map(group => group.query), ['culture']);
    assert.deepEqual(dropped.memory.stopCount, {minimum: 3, maximum: 3});
    assert.deepEqual(dropped.itinerary.input, input);
    assert.deepEqual(dropped.excludedIds, ['blocked']);
    assert.deepEqual(memory, snapshot);
  } finally {globalThis.fetch = original;}
});

test('conflicting required types fail without changing memory or silently relaxing a count', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('gallery-c', 'culture'), place('book', 'shop')];
  const previous = await fixture(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous, [{query: 'culture', category: 'culture', minimum: 3, strength: 'required', ids: candidates.slice(0, 3).map(stop => stop.id)}], undefined, {minimum: 3, maximum: 3});
  const snapshot = structuredClone(memory), original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => new URL(String(resource)).hostname === 'api.openai.com' ? searchCall('bookstore', ++calls) : json({results: {entities: [], tags: []}});
  try {
    const result = await agentPlan({config: {...config, qlooApiKey: 'conflicting-required-test'}, input, venue, candidates, previous, memory, messages: [], excludedIds: ['blocked'], request: {message: 'Keep the three required cultural places and include a bookstore'},
      turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'bookstore', category: 'shop', scope: 'plan', minimum: 1, strength: 'required'}]})});
    assert.equal(result.itinerary, undefined);
    assert.deepEqual(result.memory, snapshot);
    assert.deepEqual(result.excludedIds, ['blocked']);
    assert.deepEqual(previous.input, input);
    assert.match(result.clarification!, /keeping 3 culture stops/);
    assert.ok(calls <= 2);
  } finally {globalThis.fetch = original;}
});

test('an atomic target, arrival change and budget update apply together or leave the entire accepted state intact', async () => {
  const candidates = [place('target', 'culture'), place('keep-food', 'food'), place('keep-shop', 'shop'), place('new-gallery', 'culture')];
  const previous = await fixture(candidates), memory = createRevisionMemory(previous), snapshot = structuredClone(memory);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Valid cached goals or invalid input should not trigger outside calls');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, messages: [], excludedIds: [], request: {message: 'Swap first, make it cheaper, and arrive at 6:15 PM'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: 'target', budgetUpdate: 'low', arrivalUpdate: '18:15'})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['new-gallery', 'keep-food', 'keep-shop']);
    assert.deepEqual(result.itinerary.input, {...input, budget: 'low', arrivalBy: '18:15'});
    const invalid = await agentPlan({config, input, venue, candidates, previous, memory, messages: [], excludedIds: [], request: {message: 'Swap first and arrive after the show'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: 'target', budgetUpdate: 'low', arrivalUpdate: '20:00'})});
    assert.equal(invalid.itinerary, undefined);
    assert.match(invalid.clarification!, /arrival.*before.*show/i);
    assert.deepEqual(invalid.memory, snapshot);
    assert.deepEqual(invalid.excludedIds, []);
    assert.deepEqual(previous.input, input);
  } finally {globalThis.fetch = original;}
});
