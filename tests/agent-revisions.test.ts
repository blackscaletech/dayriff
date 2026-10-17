import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, PlanInput, Venue } from '../src/shared/types.js';
import { loadConfig } from '../src/server/config.js';
import { agentPlan } from '../src/server/providers/openai.js';
import {defaultTurnIntent as intent} from '../src/server/services/journey-intent.js';
import { checkPlan } from '../src/server/services/planner.js';
import { createRevisionMemory, rememberPlan } from '../src/server/services/revision-memory.js';
import { revisionSummary } from '../src/server/services/revisions.js';

const venue: Venue = {id: 'venue', name: 'Venue', city: 'Test City', address: 'A test address', coordinates: {latitude: 40.72, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-30', showTime: '18:30', durationMinutes: 180, startingPoint: 'venue'};
const places: Place[] = ['A Books', 'B Gallery', 'C Museum', 'D Books', 'E Books', 'F Garden'].map((name, index) => ({
  id: `place-${index}`, name, category: index === 0 || index === 3 || index === 4 ? 'shop' : 'culture',
  address: 'A test address', coordinates: {latitude: 40.72 + index * .0001, longitude: -73.99},
  description: name.includes('Books') ? 'A bookstore with a neighborhood book selection.' : 'A cultural visitor attraction.', costTier: 1, durationMinutes: 25,
}));
const config = loadConfig({APP_MODE: 'live', OPENAI_API_KEY: 'test-only', QLOO_API_KEY: 'test-only'});
function proposal(stopIds: string[], extra: Record<string, unknown> = {}) {
  return {action: 'adjust', minimum_changes: 0, drop_preferences: [], reject_ids: [], restore_ids: [], stop_ids: stopIds,
    budget_update: 'unchanged', arrival_update: 'unchanged', walking: 'unchanged', clarification: null, stop_notes: [], ...extra};
}
function response(args: unknown, name = 'check_plan'): Response {
  return new Response(JSON.stringify({output: [{type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'call-test'}]}), {status: 200, headers: {'Content-Type': 'application/json'}});
}
test('questions preserve the exact plan, preferences, rejections, and history', async () => {
  const checked = await checkPlan({ids: places.slice(0, 3).map(place => place.id), input, venue, candidates: places, mode: 'live'});
  assert.ok(checked.itinerary);
  Object.assign(checked.itinerary.stops[0]!, {matchReason: 'A Qloo taste match for Artist.', affinity: .8,
    phone: '+1 212 555 0100', source: {title: 'A Books', url: 'https://example.com/books'},
    openingHours: [{day: 'monday', closed: false, periods: [{opens: '10:00', closes: '18:00'}]}]});
  const memory = rememberPlan(createRevisionMemory(), checked.itinerary, [{query: 'bookstore', ids: [places[0]!.id], minimum: 1}], checked.itinerary.totalWalkMinutes);
  const snapshot = structuredClone(memory);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com', 'Questions must never discover or enrich other places');
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools.map((tool: {name: string}) => tool.name), ['answer_plan']);
    assert.deepEqual(Object.keys(body.tools[0].parameters.properties), ['answer'], 'No mutation arguments are available');
    const context = JSON.parse(body.input[0].content);
    assert.equal(context.candidates, undefined);
    assert.equal(context.currentPlan.michelinStarStatus, 'unverified');
    assert.deepEqual(context.currentPlan.activeSettings, {budgetFiltering: false, budget: null, arrivalBy: null}, 'Unset optional filters are known off, not unknown facts');
    assert.equal(context.currentPlan.totalWalkMinutes, checked.itinerary!.totalWalkMinutes);
    assert.equal(context.currentPlan.stops[0].description, places[0]!.description);
    assert.equal(context.currentPlan.stops[0].affinity, .8);
    assert.equal(context.currentPlan.stops[0].phone, '+1 212 555 0100');
    assert.ok(context.currentPlan.stops[0].openingHours);
    assert.equal(context.currentPlan.stops[1].openingHours, undefined, 'Missing hours remain unknown');
    assert.equal(context.currentPlan.stops[1].affinity, undefined, 'Missing artist evidence is not inferred from rank');
    return response({answer: 'A Books is the bookstore in your current route. Qloo supplied a taste match for Artist.'}, 'answer_plan');
  };
  try {
    const result = await agentPlan({config, input, venue, candidates: places, previous: checked.itinerary, memory,
      turnIntent: intent({kind: 'answer'}), request: {message: 'Why these places?'}, messages: [], excludedIds: [places[3]!.id]});
    assert.equal(result.itinerary, undefined);
    assert.match(result.clarification!, /A Books/);
    assert.match(result.clarification!, /Qloo supplied/, 'Ordinary grounded answers must not become availability errors');
    assert.equal(calls, 1, 'A question uses one bounded model response');
    assert.equal(result.candidates, places, 'Questions preserve the exact candidate pool');
    assert.deepEqual(result.memory, snapshot);
    assert.deepEqual(result.excludedIds, [places[3]!.id]);
    assert.equal(checked.itinerary.revision, 0);
  } finally { globalThis.fetch = original; }
});
test('a complete validated answer longer than 600 characters survives without changing plan state', async () => {
  const checked = await checkPlan({ids: places.slice(0, 3).map(place => place.id), input, venue, candidates: places, mode: 'live'});
  assert.ok(checked.itinerary);
  const prior = structuredClone(checked.itinerary);
  const memory = rememberPlan(createRevisionMemory(), checked.itinerary, [{query: 'bookstore', ids: [places[0]!.id], minimum: 1}], checked.itinerary.totalWalkMinutes);
  const savedMemory = structuredClone(memory);
  const messages = [{role: 'user' as const, text: 'Keep a bookstore in the plan'}, {role: 'assistant' as const, text: 'Your current plan includes A Books.'}];
  const savedMessages = structuredClone(messages);
  const excludedIds = [places[4]!.id];
  const answer = [
    'A Books gives you a neighborhood bookstore to browse, matching the bookstore preference you asked to keep in the outing.',
    'B Gallery and C Museum add cultural visitor attractions, so the route combines browsing with two different cultural stops.',
    'Each planned visit has a 25-minute allowance, and the estimated walking time is already included in your current route.',
    'The sequence ends at Venue in Test City, using the show time and exploration duration you supplied rather than introducing another deadline.',
    'These descriptions explain the current selection; they do not establish a verified artist connection for every place or confirm current opening hours.',
    'The final stop remains C Museum, and your route and saved preferences are unchanged.',
  ].join(' ');
  assert.ok(answer.length > 600 && answer.length < 1000);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_output_tokens, 1800, 'The existing answer budget is unchanged');
    assert.deepEqual(body.tools.map((tool: {name: string}) => tool.name), ['answer_plan']);
    return response({answer}, 'answer_plan');
  };
  try {
    const result = await agentPlan({config, input, venue, candidates: places, previous: checked.itinerary, memory,
      turnIntent: intent({kind: 'answer'}), request: {message: 'Why these places?'}, messages, excludedIds});
    assert.equal(result.clarification, answer, 'The validated answer retains its complete ending');
    assert.ok(result.clarification.endsWith('your route and saved preferences are unchanged.'));
    assert.equal(result.itinerary, undefined);
    assert.deepEqual(checked.itinerary, prior);
    assert.equal(result.candidates, places);
    assert.deepEqual(result.memory, savedMemory, 'Preferences and saved plan history remain unchanged');
    assert.deepEqual(messages, savedMessages);
    assert.deepEqual(result.excludedIds, [places[4]!.id]);
    assert.equal(calls, 1, 'A complete answer still uses one bounded model call');
  } finally {globalThis.fetch = original;}
});

test('fresh alternatives do not cycle and later budget adjustments preserve the bookstore preference', async () => {
  const checked = await checkPlan({ids: places.slice(0, 3).map(place => place.id), input, venue, candidates: places, mode: 'live'});
  assert.ok(checked.itinerary);
  const preference = {query: 'bookstore', ids: [places[0]!.id, places[3]!.id, places[4]!.id], minimum: 1};
  const memory = rememberPlan(createRevisionMemory(), checked.itinerary, [preference]);
  memory.shown.push({id: places[3]!.id, name: places[3]!.name});
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    const ids = calls === 1 ? [places[3]!.id, places[1]!.id, places[2]!.id]
      : calls === 3 ? [places[1]!.id, places[2]!.id, places[5]!.id]
      : [places[4]!.id, places[1]!.id, places[2]!.id];
    return response(proposal(ids, calls <= 2 ? {action: 'alternatives', minimum_changes: 1} : {budget_update: 'low'}));
  };
  try {
    const alternative = await agentPlan({config, input, venue, candidates: places, previous: checked.itinerary, memory,
      turnIntent: intent({kind: 'alternatives', minimumChanges: 1}), request: {message: 'Something different please'}, messages: [], excludedIds: []});
    assert.ok(alternative.itinerary);
    assert.ok(alternative.itinerary.stops.some(stop => stop.id === places[4]!.id));
    assert.ok(!alternative.itinerary.stops.some(stop => stop.id === places[3]!.id), 'Avoid a previously shown bookstore while a fresh one fits');
    assert.deepEqual(alternative.excludedIds, [], 'History is not a hard rejection');
    const summary = revisionSummary(checked.itinerary, alternative.itinerary);
    assert.match(summary, /E Books/); assert.doesNotMatch(summary, /opening hours/);
    const cheaper = await agentPlan({config, input: alternative.itinerary.input, venue, candidates: alternative.candidates, previous: alternative.itinerary, memory: alternative.memory,
      turnIntent: intent({kind: 'adjust', budgetUpdate: 'low'}), request: {message: 'Make it cheaper'}, messages: [], excludedIds: []});
    assert.ok(cheaper.itinerary);
    assert.equal(cheaper.itinerary.input.budget, 'low');
    assert.ok(cheaper.itinerary.stops.some(stop => stop.id === places[4]!.id));
    assert.equal(cheaper.memory.preferences[0]?.query, 'bookstore');
    assert.equal(calls, 0, 'Typed cached adjustments need no additional planning model calls');
  } finally { globalThis.fetch = original; }
});

test('a verified fresh three-stop goal applies without model repair or exploratory searches', async () => {
  const fresh: Place[] = [1, 2, 3].map(index => ({...places[1]!, id: `fresh-${index}`, name: `Fresh Gallery ${index}`,
    coordinates: {latitude: 40.721 + index * .0001, longitude: -73.991}}));
  const candidates = [...places, ...fresh];
  const prior = await checkPlan({ids: places.slice(3, 6).map(place => place.id), input, venue, candidates, mode: 'live'});
  assert.ok(prior.itinerary);
  const memory = createRevisionMemory(prior.itinerary);
  memory.shown = places.map(place => ({id: place.id, name: place.name}));
  memory.plans = [places.slice(0, 3).map(place => place.id), places.slice(3, 6).map(place => place.id)];
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    return response(proposal([], {action: 'alternatives', minimum_changes: 3,
      clarification: 'I couldn’t find three additional verified nearby options beyond the two sets you’ve already seen.'}));
  };
  try {
    const result = await agentPlan({config, input, venue, candidates, previous: prior.itinerary, memory,
      turnIntent: intent({kind: 'alternatives', minimumChanges: 3, stopCount: {minimum: 3, maximum: 3}}), request: {message: 'Another completely new three-stop plan please. I’ve already seen both sets.'}, messages: [], excludedIds: []});
    assert.ok(result.itinerary, 'A model denial cannot override server-verified availability');
    assert.equal(result.itinerary.stops.length, 3);
    assert.ok(result.itinerary.stops.every(stop => fresh.some(place => place.id === stop.id)));
    assert.equal(calls, 0, 'A complete trusted goal needs no selection or repair model calls');
    assert.equal(result.memory.plans.length, 3);
    assert.deepEqual(result.excludedIds, []);
  } finally { globalThis.fetch = original; }
});

test('first plans retain a checked shorter outing when repeated three-stop proposals cannot fit the custom start', async () => {
  const concert = {...venue, coordinates: {latitude: 40.7505045, longitude: -73.9934387}};
  const start = {name: 'SoHo', address: 'SoHo, New York, NY', approximate: true, coordinates: {latitude: 40.7234729441, longitude: -74.00086511}};
  const submitted: PlanInput = {...input, showTime: '17:30', startingPoint: 'aeround soho area', budget: 'low', arrivalBy: '17:10'};
  const candidates: Place[] = [40.724, 40.730, 40.740].map((latitude, index) => ({...places[1]!, id: `first-${index}`, name: `Local Gallery ${index}`,
    coordinates: {latitude, longitude: -73.996}, durationMinutes: 50}));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    const body = JSON.parse(String(init?.body));
    const context = JSON.parse(body.input[0].content);
    assert.equal(context.checkedSuggestedPlan.stopIds.length, 2, 'The model receives a fully checked two-stop option before its first proposal');
    assert.ok(context.checkedSuggestedPlan.totalMinutes <= 180);
    assert.deepEqual(context.startingLocation, start);
    assert.deepEqual(Object.keys(body.tools[0].parameters.properties).sort(), ['stop_ids', 'stop_notes'], 'The first-plan model cannot set revision fields or create an arrival deadline');
    return response({stop_ids: candidates.map(place => place.id), stop_notes: []});
  };
  try {
    const result = await agentPlan({config, input: submitted, venue: concert, startingLocation: start, candidates, messages: [], excludedIds: []});
    assert.ok(result.itinerary, 'A feasible shorter plan must survive repeated overlong model proposals');
    assert.equal(result.itinerary.stops.length, 2);
    assert.ok(result.itinerary.totalMinutes <= 180);
    assert.deepEqual(result.itinerary.input, submitted, 'Budget, deadline, duration, and typo text are preserved');
    assert.deepEqual(result.itinerary.startingLocation, start);
    assert.equal(result.itinerary.revision, 0);
    assert.equal(calls, 2, 'No additional model round is needed');
  } finally { globalThis.fetch = original; }
});

test('first-plan fallback preserves submitted constraints after invented deadlines and malformed place IDs', async () => {
  const submitted: PlanInput = {...input, budget: 'low'};
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    return response(calls === 1
      ? proposal([], {budget_update: 'unset', arrival_update: '15:00', walking: 'less', reject_ids: [places[0]!.id]})
      : {stop_ids: ['invented-place-id'], stop_notes: []});
  };
  try {
    const result = await agentPlan({config, input: submitted, venue, candidates: places, messages: [], excludedIds: []});
    assert.ok(result.itinerary);
    assert.deepEqual(result.itinerary.input, submitted);
    assert.equal(result.itinerary.input.arrivalBy, undefined, 'Show time is never copied into an omitted arrival preference');
    assert.deepEqual(result.excludedIds, [], 'The model cannot invent a first-plan rejection');
    assert.equal(result.memory.walkingLimit, undefined, 'The model cannot invent a walking preference');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('first-plan failures are truthful when no plan satisfies the submitted budget', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async resource => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    return response({stop_ids: [places[0]!.id], stop_notes: []});
  };
  try {
    const unavailable = await agentPlan({config, input: {...input, budget: 'low'}, venue,
      candidates: [{...places[0]!, costTier: undefined}], messages: [], excludedIds: []});
    assert.equal(unavailable.itinerary, undefined, 'Unknown prices cannot silently satisfy a low budget');
    assert.match(unavailable.clarification!, /could not fit nearby stops/i);
    assert.doesNotMatch(unavailable.clarification!, /different outing|update/i);
  } finally { globalThis.fetch = original; }
});

test('one-click swaps use a cached verified replacement without a model call or changing other stops', async () => {
  const prior = await checkPlan({ids: places.slice(0, 2).map(place => place.id), input, venue, candidates: places, mode: 'live'});
  assert.ok(prior.itinerary);
  const memory = createRevisionMemory(prior.itinerary);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('A feasible cached swap must not call an external provider or language model'); };
  try {
    const result = await agentPlan({config, input, venue, candidates: places, previous: prior.itinerary, memory,
      request: {message: `Find an alternative to ${places[0]!.name}`, replaceStopId: places[0]!.id}, messages: [], excludedIds: []});
    assert.ok(result.itinerary);
    assert.equal(result.itinerary.stops.length, 2);
    assert.notEqual(result.itinerary.stops[0]!.id, places[0]!.id);
    assert.equal(result.itinerary.stops[1]!.id, places[1]!.id);
    assert.deepEqual(result.itinerary.input, prior.itinerary.input);
    assert.equal(result.itinerary.revision, prior.itinerary.revision + 1);
    assert.deepEqual(result.excludedIds, [places[0]!.id]);
    assert.equal(result.memory.plans.length, 2);
  } finally { globalThis.fetch = original; }
});

test('an unavailable swap keeps the previous route, memory and rejection state intact', async () => {
  const candidates = places.slice(0, 2);
  const prior = await checkPlan({ids: candidates.map(place => place.id), input, venue, candidates, mode: 'live'});
  assert.ok(prior.itinerary);
  const memory = createRevisionMemory(prior.itinerary);
  const snapshot = structuredClone(memory);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    assert.notEqual(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    return new Response(JSON.stringify({results: {entities: [], tags: []}}), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  try {
    const result = await agentPlan({config, input, venue, candidates, previous: prior.itinerary, memory,
      request: {message: `Find an alternative to ${places[0]!.name}`, replaceStopId: places[0]!.id}, messages: [], excludedIds: []});
    assert.equal(result.itinerary, undefined);
    assert.match(result.clarification!, /Your route is unchanged/);
    assert.deepEqual(result.memory, snapshot);
    assert.deepEqual(result.excludedIds, []);
    assert.deepEqual(prior.itinerary.stops.map(stop => stop.id), candidates.map(place => place.id));
    assert.ok(calls <= 4, 'At most two grounded type searches run, with no agent loop');
  } finally { globalThis.fetch = original; }
});

test('initial planning uses the highest checked feasible count even if the model omits stops', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    return response({stop_ids: [places[0]!.id], stop_notes: []});
  };
  try {
    const result = await agentPlan({config, input, venue, candidates: places, messages: [], excludedIds: []});
    assert.equal(result.itinerary?.stops.length, 3);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});


test('mixed questions requesting additions or replacements keep the revision tools', async () => {
  const prior = await checkPlan({ids: places.slice(0, 3).map(place => place.id), input, venue, candidates: places, mode: 'live'});
  assert.ok(prior.itinerary);
  const original = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    const body = JSON.parse(String(init?.body));
    assert.ok(body.tools.some((tool: {name: string}) => tool.name === 'find_places'));
    assert.ok(!body.tools.some((tool: {name: string}) => tool.name === 'answer_plan'));
    return response(proposal([places[3]!.id, places[1]!.id, places[2]!.id], {action: 'alternatives', minimum_changes: 1}));
  };
  try {
    for (const message of ['Why not add a bookstore?', 'Can you replace the first stop?', 'Why these places, and please replace the first stop?']) {
      const result = await agentPlan({config, input, venue, candidates: places, previous: prior.itinerary,
        turnIntent: intent({kind: 'alternatives', minimumChanges: 1}), request: {message}, messages: [], excludedIds: []});
      assert.ok(result.itinerary, message);
      assert.equal(result.itinerary.stops[0]!.id, places[3]!.id);
    }
  } finally { globalThis.fetch = original; }
});

test('a colloquial question uses the grounded read-only answer provider', async () => {
  const prior = await checkPlan({ids: places.slice(0, 3).map(place => place.id), input, venue, candidates: places, mode: 'live'});
  assert.ok(prior.itinerary);
  const original = globalThis.fetch;
  globalThis.fetch = async resource => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    return response({answer: 'Qloo supplied A Books, a neighborhood bookstore, for this outing.'}, 'answer_plan');
  };
  try {
    const result = await agentPlan({config, input, venue, candidates: places, previous: prior.itinerary,
      turnIntent: intent({kind: 'answer'}), request: {message: 'A Books fits my taste?'}, messages: [], excludedIds: []});
    assert.equal(result.itinerary, undefined);
    assert.equal(result.clarification, 'Qloo supplied A Books, a neighborhood bookstore, for this outing.');
  } finally { globalThis.fetch = original; }
});
