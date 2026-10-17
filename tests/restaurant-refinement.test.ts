import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, PlanInput, Venue } from '../src/shared/types.js';
import { loadConfig } from '../src/server/config.js';
import { agentPlan } from '../src/server/providers/openai.js';
import {defaultTurnIntent as intent} from '../src/server/services/journey-intent.js';
import { checkPlan } from '../src/server/services/planner.js';
import { createRevisionMemory, rememberPlan } from '../src/server/services/revision-memory.js';
import { revisionSummary } from '../src/server/services/revisions.js';

const venue: Venue = {id: 'concert', name: 'Concert', city: 'New York', address: 'New York, NY', coordinates: {latitude: 40.7505045, longitude: -73.9934387}, website: '', timezone: 'America/New_York'};
const start = {name: 'Starting neighborhood', address: 'New York, NY', coordinates: {latitude: 40.7234729441, longitude: -74.00086511}, approximate: true};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-30', showTime: '17:30', durationMinutes: 180, startingPoint: 'around the neighborhood'};
const galleries: Place[] = [[40.7411, -73.9897], [40.7484, -73.9857]].map(([latitude, longitude], index) => ({id: `gallery-${index}`, name: `Local Gallery ${index}`, category: 'culture', address: '', coordinates: {latitude: latitude!, longitude: longitude!}, description: 'A visitor art gallery.', durationMinutes: 35, taxonomy: ['urn:tag:genre:place:art_gallery']}));
const config = loadConfig({APP_MODE: 'live', QLOO_API_URL: 'https://api.qloo.com', QLOO_API_KEY: 'restaurant-refinement-test-only', OPENAI_API_KEY: 'test-only'});
const restaurantTag = 'urn:tag:genre:place:restaurant';
const restaurantEntities = [[40.735, -73.983], [40.741, -73.982], [40.748, -73.982]].map(([lat, lon], index) => ({
  entity_id: `55555555-5555-5555-5555-${String(index + 1).padStart(12, '0')}`, name: `Neighborhood Restaurant ${index + 1}`, subtype: 'urn:entity:place', location: {lat, lon},
  tags: [{id: restaurantTag, type: 'urn:tag:genre:place', name: 'Restaurant'}], properties: {description: 'A neighborhood restaurant with a regional menu.', price_level: 1},
}));
function json(value: unknown) {return new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}});}
function proposal(ids: string[], extra: Record<string, unknown> = {}) {return {action: 'adjust', minimum_changes: 1, drop_preferences: [], reject_ids: [], restore_ids: [], stop_ids: ids, budget_update: 'unchanged', arrival_update: 'unchanged', walking: 'unchanged', clarification: null, clarification_kind: null, stop_notes: [], ...extra};}
function tool(name: string, arguments_: unknown) {return json({output: [{type: 'function_call', name, arguments: JSON.stringify(arguments_), call_id: 'test-call'}]});}

test('a restaurant refinement after less walking retains a fuller verified outing instead of a hidden hard ceiling', async () => {
  const initial = await checkPlan({ids: galleries.map(place => place.id), input, venue, candidates: galleries, mode: 'live', startingLocation: start});
  assert.ok(initial.itinerary);
  assert.equal(initial.itinerary.totalWalkMinutes, 82);
  const memory = rememberPlan(createRevisionMemory(initial.itinerary), initial.itinerary, [], 82);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') {
      calls++;
      const sent = JSON.parse(String(init?.body));
      const context = JSON.parse(sent.input[0].content);
      assert.equal(context.preferredWalkMinutes, 82);
      if (calls === 1) return tool('check_plan', proposal([], {action: 'answer', clarification: 'No restaurants were supplied.'}));
      if (calls === 2) {
        assert.equal(sent.tool_choice.name, 'find_places', 'An imperative preference cannot be denied before discovery');
        return tool('find_places', {query: 'restaurants', minimum_stops: 1, purpose: 'preference', refine_previous_search: false, drop_preferences: []});
      }
      // Carrying walking=less from the previous turn must not restore the hidden ceiling.
      return tool('check_plan', proposal((calls === 3 ? restaurantEntities : restaurantEntities.slice(0, 1)).map(place => place.entity_id), {walking: calls === 3 ? 'less' : 'clear_limit'}));
    }
    assert.equal(url.hostname, 'api.qloo.com');
    if (url.pathname === '/v2/tags') return json({results: {tags: [{tag_id: restaurantTag, type: 'urn:tag:genre:place', name: 'Restaurants'}]}});
    return json({results: {entities: restaurantEntities}});
  };
  try {
    const result = await agentPlan({config, input, venue, candidates: galleries, previous: initial.itinerary, startingLocation: start, memory, excludedIds: [],
      messages: [{role: 'user', text: 'Less walking'}, {role: 'assistant', text: '82 minutes of estimated walking.'}], turnIntent: intent({kind: 'adjust', placeRequests: [{query: 'restaurants', minimum: 1, strength: 'preference'}]}), request: {message: 'more restaurants'}});
    assert.ok(result.itinerary);
    assert.equal(result.itinerary.stops.length, 2, 'A feasible fuller plan must survive invalid and undersized model proposals');
    assert.ok(result.itinerary.stops.some(place => place.taxonomy?.includes(restaurantTag)));
    assert.ok(result.itinerary.totalWalkMinutes > 82, 'A remembered qualitative preference must allow the new requested stop');
    assert.ok(result.itinerary.totalMinutes <= input.durationMinutes);
    assert.deepEqual(result.itinerary.input, input, 'Optional budget/deadline and all submitted constraints stay unchanged');
    assert.deepEqual(result.itinerary.startingLocation, start);
    assert.equal(result.memory.walkingLimit, 82, 'The shorter-walk preference is retained as a soft target');
    assert.equal(result.memory.preferences[0]?.query, 'restaurants');
    assert.equal(result.memory.plans.length, 2);
    assert.deepEqual(result.excludedIds, []);
    assert.match(revisionSummary(initial.itinerary, result.itinerary), /Estimated walking increases by \d+ minutes/);
    assert.ok(calls <= 4, 'Repair and fallback stay within the existing model-call budget');
  } finally {globalThis.fetch = original;}
});

test('less walking keeps fuller feasible stops while an explicit one-stop request is respected', async () => {
  const nearby: Place[] = [40.736, 40.742].map((latitude, index) => ({...galleries[0]!, id: `nearby-${index}`, name: `Nearby Gallery ${index}`, coordinates: {latitude, longitude: -73.993}}));
  const candidates = [...galleries, ...nearby];
  const initial = await checkPlan({ids: galleries.map(place => place.id), input, venue, candidates, mode: 'live', startingLocation: start});
  assert.ok(initial.itinerary);
  const original = globalThis.fetch;
  globalThis.fetch = async resource => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    return tool('check_plan', proposal([nearby[0]!.id], {walking: 'less'}));
  };
  try {
    for (const [message, expectedCount] of [['Less walking', 2], ['Less walking, just one stop', 1]] as const) {
      const result = await agentPlan({config, input, venue, candidates, previous: initial.itinerary, startingLocation: start, messages: [], excludedIds: [], turnIntent: intent({kind: 'adjust', walking: 'less', ...(expectedCount === 1 ? {stopCount: {minimum: 1, maximum: 1}} : {})}), request: {message}});
      assert.ok(result.itinerary, message);
      assert.equal(result.itinerary.stops.length, expectedCount, message);
      assert.ok(result.itinerary.totalWalkMinutes < initial.itinerary.totalWalkMinutes, 'A current explicit walking reduction stays strict');
    }
  } finally {globalThis.fetch = original;}
});
