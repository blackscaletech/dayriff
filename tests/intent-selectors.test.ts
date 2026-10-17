import assert from 'node:assert/strict';
import test from 'node:test';
import type {Itinerary, Stop} from '../src/shared/types.js';
import type {ServerConfig} from '../src/server/config.js';
import type {RevisionMemory} from '../src/server/services/revision-memory.js';
import {interpretTurn} from '../src/server/providers/turn-intent.js';

const config: ServerConfig = {mode: 'live', production: false, port: 3000, host: '127.0.0.1', qlooApiUrl: 'https://api.qloo.com',
  openaiApiKey: 'offline-intent-test', openaiModel: 'test-model', openaiReasoningEffort: 'medium', cookieSecret: 'offline-test-cookie', maxDailyPlans: 10, maxDailyLookups: 10};
const venue = {id: 'venue', name: 'Concert', city: 'New York', address: '', coordinates: {latitude: 40.75, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const stop: Stop = {id: 'current-museum', name: 'Current Museum', category: 'culture', address: '', coordinates: venue.coordinates,
  description: 'A neighborhood museum.', durationMinutes: 35, walkMinutes: 5, arrivalTime: '15:35', departureTime: '16:10', arrivalDate: '2026-10-22', departureDate: '2026-10-22', reason: 'Art and local history.'};
const previous: Itinerary = {id: 'plan', mode: 'live', input: {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-22', showTime: '19:00', durationMinutes: 180, startingPoint: 'Near the venue', budget: 'low'},
  venue, stops: [stop], totalWalkMinutes: 10, totalMinutes: 45, estimatedArrival: '16:15', estimatedArrivalDate: '2026-10-22', routeUrl: '', notices: [], revision: 0};
const emptyMemory = (): RevisionMemory => ({shown: [{id: 'earlier-cafe', name: 'Earlier Cafe'}], plans: [[stop.id]], preferences: []});
function response(overrides: Record<string, unknown> = {}) {
  return {kind: 'adjust', stop_count_operation: 'unchanged', minimum_total_stops: 0, maximum_total_stops: 0, replace_stop_id: null, keep_stop_ids: [], place_scope: 'unchanged', place_policy_facts: [], place_requests: [],
    drop_preferences: [], keep_preferences: [], minimum_changes: 0, show_time_update: 'unchanged', duration_update: null, budget_update: 'unchanged', arrival_update: 'unchanged', walking: 'unchanged', reject_ids: [], restore_ids: [], clarification: null, ...overrides};
}
function place(overrides: Record<string, unknown> = {}) {
  return {query: 'culture', minimum: 1, maximum: null, operation: 'increase', scope: 'plan', strength: 'preference', exclusive: false, category: 'culture', dining_style: 'any', recognition: 'any', ...overrides};
}
function policy(effect: 'exclude' | 'withdraw' | 'allow', query: string, evidence_quote: string, overrides: Record<string, unknown> = {}) {
  return {effect, evidence_quote, query, active_query: null, scope: 'plan', target_id: null, category: 'any', dining_style: 'any', recognition: 'any', ...overrides};
}
async function interpret(options: {reply: Record<string, unknown>; message?: string; memory?: RevisionMemory; plan?: Itinerary; inspect?: (body: any) => void}) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    calls++;
    assert.equal(String(resource), 'https://api.openai.com/v1/responses', 'The test permits only one mocked semantic request.');
    options.inspect?.(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({output: [{type: 'function_call', name: 'interpret_turn', arguments: JSON.stringify(options.reply)}]}), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  try {
    return await interpretTurn({config, previous: options.plan ?? previous, request: {message: options.message ?? 'Change the plan.'}, memory: options.memory ?? emptyMemory(), messages: [], candidateIds: [stop.id, 'cached-bookstore', 'earlier-cafe']});
  } finally {globalThis.fetch = original; assert.equal(calls, 1, 'An accepted or rejected interpretation never triggers a repair round.');}
}

test('removing the budget and asking for more culture uses dedicated budget update and one semantic call', async () => {
  const intent = await interpret({message: 'Remove budget preference and give me more culture', reply: response({budget_update: 'unset', place_requests: [place()]}), inspect: body => {
    const properties = body.tools[0].parameters.properties;
    assert.equal(body.tools[0].strict, true);
    assert.deepEqual(properties.drop_preferences, properties.keep_preferences);
    assert.equal(properties.drop_preferences.maxItems, 0, 'No active place query means budget cannot be emitted as a place selector.');
    assert.equal(properties.drop_preferences.items.enum, undefined, 'A zero-length array avoids an invalid empty JSON Schema enum.');
    assert.deepEqual(properties.replace_stop_id.enum, [stop.id, null]);
    assert.deepEqual(properties.budget_update.enum, ['unchanged', 'unset', 'low', 'medium', 'high']);
    assert.match(body.instructions, /Removing the budget preference uses budget_update=unset/);
  }});
  assert.equal(intent.kind, 'adjust');
  assert.equal(intent.budgetUpdate, 'unset');
  assert.deepEqual(intent.dropPreferences, []);
  assert.equal(intent.placeRequests[0]?.query, 'culture');
  assert.equal(intent.placeRequests[0]?.operation, 'increase');
  assert.equal(intent.placeRequests[0]?.maximum, undefined, 'Nullable wire maximum does not enter the domain intent.');
  assert.equal(intent.minimumChanges, 1);
});

test('keep and drop selectors enumerate only unique active queries in their canonical case', async () => {
  const memory = emptyMemory();
  memory.preferences = [{query: 'Bookstore', ids: [], minimum: 1}, {query: 'culture', ids: [stop.id], minimum: 1}, {query: 'Bookstore', ids: [], minimum: 1}];
  const intent = await interpret({memory, message: 'Keep Bookstore, remove culture.', reply: response({place_policy_facts: [policy('allow', 'Bookstore', 'Keep Bookstore', {active_query: 'Bookstore'}), policy('withdraw', 'culture', 'remove culture', {active_query: 'culture'})], keep_preferences: ['Bookstore'], drop_preferences: ['culture']}), inspect: body => {
    const properties = body.tools[0].parameters.properties;
    for (const name of ['keep_preferences', 'drop_preferences']) {
      assert.deepEqual(properties[name].items.enum, ['Bookstore', 'culture']);
      assert.equal(properties[name].maxItems, 2);
    }
    assert.deepEqual(properties.replace_stop_id.enum, [stop.id, null], 'Cached and previously shown IDs cannot become atomic replacement targets.');
  }});
  assert.deepEqual(intent.keepPreferences, ['Bookstore']);
  assert.deepEqual(intent.dropPreferences, ['culture']);
});

test('unexpected, mis-cased or duplicate selectors and noncurrent replacement IDs fail closed', async () => {
  const memory = emptyMemory();
  memory.preferences = [{query: 'Bookstore', ids: [], minimum: 1}, {query: 'culture', ids: [stop.id], minimum: 1}];
  for (const invalid of [
    {drop_preferences: ['budget']}, {keep_preferences: ['bookstore']}, {drop_preferences: ['Bookstore', 'Bookstore']},
    {replace_stop_id: 'cached-bookstore'}, {replace_stop_id: 'earlier-cafe'},
  ]) await assert.rejects(interpret({memory, reply: response(invalid)}), {code: 'INVALID_INTENT'});
  await assert.rejects(interpret({reply: response({drop_preferences: ['budget']})}), {code: 'INVALID_INTENT'});
});

test('without a current route the replacement selector allows only null and no invented preference selector', async () => {
  const intent = await interpret({plan: {...previous, stops: []}, reply: response({kind: 'answer'}), inspect: body => {
    const properties = body.tools[0].parameters.properties;
    assert.deepEqual(properties.replace_stop_id.enum, [null]);
    assert.equal(properties.keep_preferences.maxItems, 0);
    assert.equal(properties.drop_preferences.maxItems, 0);
  }});
  assert.equal(intent.kind, 'answer');
  await assert.rejects(interpret({plan: {...previous, stops: []}, reply: response({replace_stop_id: stop.id})}), {code: 'INVALID_INTENT'});
});

test('strict matching bounds represent an explicit exclusion without turning it into preference withdrawal', async () => {
  const intent = await interpret({message: 'No restaurants', reply: response({place_policy_facts: [policy('exclude', 'restaurant', 'No restaurants', {category: 'food'})], place_requests: [place({query: 'restaurant', minimum: 0, maximum: 0, operation: 'at_least', strength: 'required', category: 'food'})]}), inspect: body => {
    const request = body.tools[0].parameters.properties.place_requests.items;
    assert.ok(request.required.includes('maximum'));
    assert.deepEqual(request.properties.maximum.type, ['integer', 'null']);
    assert.equal(request.properties.minimum.minimum, 0);
    assert.equal(request.properties.maximum.maximum, 3);
    assert.match(body.instructions, /exclusions with maximum=0 survive both any and reset/);
    assert.match(body.instructions, /Distinguish removing a preference from refusing the kind itself/);
  }});
  assert.equal(intent.kind, 'adjust');
  assert.deepEqual(intent.dropPreferences, []);
  assert.equal(intent.placeRequests[0]?.minimum, 0);
  assert.equal(intent.placeRequests[0]?.maximum, 0);
  assert.equal(intent.placeRequests[0]?.scope, 'plan');
  assert.equal(intent.placeRequests[0]?.strength, 'required');
});

test('replacement-only exclusion keeps its target and scope instead of creating a global ban', async () => {
  const message = 'Replace the museum, not with a restaurant.';
  const intent = await interpret({message, reply: response({replace_stop_id: stop.id, place_policy_facts: [policy('exclude', 'restaurant', 'not with a restaurant', {scope: 'replacement', target_id: stop.id, category: 'food'})], place_requests: [place({query: 'restaurant', minimum: 0, maximum: 0, operation: 'at_least', scope: 'replacement', strength: 'required', category: 'food'})]})});
  assert.equal(intent.kind, 'adjust');
  assert.equal(intent.replaceStopId, stop.id);
  assert.equal(intent.placeRequests[0]?.scope, 'replacement');
  assert.equal(intent.placeRequests[0]?.maximum, 0);
  assert.equal(intent.minimumChanges, 1);
});

test('zero minima need a finite maximum and contradictory or out-of-range matching bounds fail closed', async () => {
  for (const bounds of [{minimum: 0, maximum: null}, {minimum: 2, maximum: 1}, {minimum: 0, maximum: 4}, {minimum: -1, maximum: 0}]) {
    await assert.rejects(interpret({reply: response({place_requests: [place({...bounds, operation: 'at_least'})]})}), {code: 'INVALID_INTENT'});
  }
});


test('explicit reversals replace the exact active matching query in either direction', async () => {
  for (const excluding of [false, true]) {
    const memory = emptyMemory();
    memory.preferences = [{query: 'restaurant', ids: [], minimum: excluding ? 1 : 0, ...(excluding ? {} : {maximum: 0}), strength: 'required'}];
    const request = place({query: 'restaurant', category: 'food', operation: 'at_least', minimum: excluding ? 0 : 1, maximum: excluding ? 0 : null, strength: 'required'});
    const message = excluding ? 'Actually no restaurants' : 'Actually include a restaurant';
    const intent = await interpret({memory, message, reply: response({place_policy_facts: [policy(excluding ? 'exclude' : 'allow', 'restaurant', message, {active_query: 'restaurant', category: 'food'})], drop_preferences: ['restaurant'], place_requests: [request]}), inspect: body => {
      assert.deepEqual(body.tools[0].parameters.properties.drop_preferences.items.enum, ['restaurant']);
      assert.match(body.instructions, /Conversely, when a new no-kind exclusion contradicts an active required positive request/);
    }});
    assert.equal(intent.kind, 'adjust');
    assert.deepEqual(intent.dropPreferences, ['restaurant']);
    assert.equal(intent.placeRequests[0]?.minimum, excluding ? 0 : 1);
    assert.equal(intent.placeRequests[0]?.maximum, excluding ? 0 : undefined);
  }
});


test('the single semantic tool requires policy evidence before requests with trusted active and current selectors', async () => {
  const memory = emptyMemory();
  memory.preferences = [{query: 'Bookstore', ids: [], minimum: 1}, {query: 'culture', ids: [stop.id], minimum: 1}];
  const intent = await interpret({memory, reply: response({kind: 'answer'}), inspect: body => {
    assert.equal(body.tools.length, 1, 'Policy evidence travels in the original interpretation rather than a second model request.');
    const parameters = body.tools[0].parameters, properties = parameters.properties;
    assert.ok(parameters.required.includes('place_policy_facts'));
    assert.ok(Object.keys(properties).indexOf('place_policy_facts') < Object.keys(properties).indexOf('place_requests'));
    const facts = properties.place_policy_facts;
    assert.equal(facts.maxItems, 4);
    assert.deepEqual(facts.items.properties.effect.enum, ['exclude', 'withdraw', 'allow']);
    assert.deepEqual(facts.items.properties.active_query.enum, ['Bookstore', 'culture', null]);
    assert.deepEqual(facts.items.properties.target_id.enum, [stop.id, null]);
    assert.ok(facts.items.required.includes('evidence_quote'));
    assert.ok(facts.items.required.includes('active_query'));
    assert.equal(facts.items.additionalProperties, false);
  }});
  assert.equal(intent.kind, 'answer');
  const {place_policy_facts: _facts, ...missing} = response();
  await assert.rejects(interpret({reply: missing}), {code: 'INVALID_INTENT'});
});

test('a nonverbatim policy quote fails closed without an API repair or a preference mutation', async () => {
  const memory = emptyMemory(), snapshot = structuredClone(memory);
  await assert.rejects(interpret({memory, message: 'No restaurants.', reply: response({place_policy_facts: [policy('exclude', 'restaurant', 'no restaurants', {category: 'food'})], place_requests: [place({query: 'restaurant', minimum: 0, maximum: 0, operation: 'at_least', strength: 'required', category: 'food'})]})}), {code: 'INVALID_PLACE_POLICY'});
  assert.deepEqual(memory, snapshot);
});


test('retained stop selectors enumerate current route instances only and parse a known current stop', async () => {
  const intent = await interpret({message: 'Keep the museum and remove my walking preference.', reply: response({keep_stop_ids: [stop.id], walking: 'clear_limit'}), inspect: body => {
    const parameters = body.tools[0].parameters, selector = parameters.properties.keep_stop_ids;
    assert.ok(parameters.required.includes('keep_stop_ids'));
    assert.deepEqual(selector.items.enum, [stop.id]);
    assert.ok(selector.maxItems > 0 && selector.maxItems <= 3, 'Retained instances stay within the three-stop route limit.');
    assert.ok(!selector.items.enum.includes('cached-bookstore'));
    assert.ok(!selector.items.enum.includes('earlier-cafe'));
  }});
  assert.deepEqual(intent.keepStopIds, [stop.id]);
  assert.equal(intent.walking, 'clear_limit');
  assert.deepEqual(intent.keepPreferences, [], 'Keeping one current place does not invent a whole-plan category preference.');
});

test('retained stop wire selectors reject foreign and duplicate IDs without model repair', async () => {
  for (const keep_stop_ids of [['cached-bookstore'], ['earlier-cafe'], [stop.id, stop.id]]) {
    await assert.rejects(interpret({reply: response({keep_stop_ids})}), {code: 'INVALID_INTENT'});
  }
  const {keep_stop_ids: _kept, ...missing} = response();
  await assert.rejects(interpret({reply: missing}), {code: 'INVALID_INTENT'});
});

test('an instance cannot be retained and explicitly replaced or rejected in the same turn', async () => {
  for (const conflict of [{replace_stop_id: stop.id}, {reject_ids: [stop.id]}]) {
    const intent = await interpret({reply: response({keep_stop_ids: [stop.id], ...conflict})});
    assert.equal(intent.kind, 'clarify');
    assert.equal(intent.changesPlan, false);
    assert.deepEqual(intent.keepStopIds, []);
  }
});


test('total-count wire bounds are always integers and explicit sets retain both bounds', async () => {
  const intent = await interpret({message: 'Make it exactly two stops.', reply: response({stop_count_operation: 'set', minimum_total_stops: 2, maximum_total_stops: 2}), inspect: body => {
    const properties = body.tools[0].parameters.properties;
    for (const field of ['minimum_total_stops', 'maximum_total_stops']) {
      assert.equal(properties[field].type, 'integer');
      assert.equal(properties[field].minimum, 0);
      assert.equal(properties[field].maximum, 20);
    }
  }});
  assert.equal(intent.kind, 'adjust');
  assert.deepEqual(intent.stopCount, {minimum: 2, maximum: 2});
  for (const invalid of [{minimum_total_stops: null}, {maximum_total_stops: null}, {stop_count_operation: 'set', minimum_total_stops: null, maximum_total_stops: null}]) {
    await assert.rejects(interpret({reply: response(invalid)}), {code: 'INVALID_INTENT'});
  }
  const zero = await interpret({reply: response({stop_count_operation: 'set', minimum_total_stops: 0, maximum_total_stops: 0})});
  assert.equal(zero.kind, 'clarify');
  assert.equal(zero.changesPlan, false);
});
