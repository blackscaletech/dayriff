import assert from 'node:assert/strict';
import test from 'node:test';
import type { Category, Place, PlanInput, Venue } from '../src/shared/types.js';
import { loadConfig } from '../src/server/config.js';
import { agentPlan } from '../src/server/providers/openai.js';
import { checkPlan } from '../src/server/services/planner.js';
import { defaultTurnIntent } from '../src/server/services/journey-intent.js';
import { createRevisionMemory, rememberPlan } from '../src/server/services/revision-memory.js';

const venue: Venue = {id: 'venue', name: 'Concert', city: 'New York', address: '', coordinates: {latitude: 40.75, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-22', showTime: '19:00', durationMinutes: 360, startingPoint: 'SoHo', budget: 'low'};
const config = loadConfig({APP_MODE: 'live', OPENAI_API_KEY: 'test-only', QLOO_API_KEY: 'rebalance-test', QLOO_API_URL: 'https://api.qloo.com'});
const kind: Record<Category, string> = {culture: 'art_gallery', food: 'cafe', shop: 'bookstore', outdoors: 'park'};
function place(id: string, category: Category): Place {
  return {id, name: `Local ${kind[category]} ${id}`, category, address: 'New York', coordinates: venue.coordinates,
    description: `An independent neighborhood ${kind[category]}.`, taxonomy: [`urn:tag:genre:place:${kind[category]}`], durationMinutes: 25, costTier: 1};
}
async function current(candidates: Place[]) {
  const checked = await checkPlan({ids: candidates.slice(0, 3).map(stop => stop.id), input, venue, candidates, mode: 'live'});
  assert.ok(checked.itinerary, checked.issues.join(' '));
  return checked.itinerary;
}

test('relative tastes replace one stop in a full route for every category, without accumulating old soft tastes', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('A verified cached replacement needs no external call');};
  try {
    for (const category of Object.keys(kind) as Category[]) await t.test(category, async () => {
      const other = category === 'food' ? 'shop' : 'food';
      const candidates = [place('matching', category), place('keep', other), place('replace', other), place('new', category)];
      const previous = await current(candidates);
      const memory = rememberPlan(createRevisionMemory(previous), previous,
        [{query: other, category: other, minimum: 2, strength: 'preference', ids: ['keep', 'replace']}], undefined, {minimum: 3, maximum: 3});
      const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [],
        request: {message: `More ${category}`}, turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: category, category, minimum: 1, operation: 'increase', strength: 'preference'}]})});
      assert.ok(result.itinerary, result.clarification);
      assert.equal(result.itinerary.stops.length, 3);
      assert.equal(result.itinerary.stops.filter(stop => stop.category === category).length, 2, 'The server increases the real matching count, not the model minimum=1');
      assert.equal(result.itinerary.stops.filter(stop => previous.stops.some(old => old.id === stop.id)).length, 2, 'Only one actual place is replaced');
      assert.deepEqual(result.itinerary.input, input);
      assert.deepEqual(result.memory.stopCount, {minimum: 3, maximum: 3});
      assert.deepEqual(result.excludedIds, [], 'A swap is not a permanent rejection');
      assert.equal(result.memory.plans.length, 2);
    });
  } finally {globalThis.fetch = original;}
});

test('a fully matching route gets a different place; a shorter route keeps its count without inventing a saved count requirement', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('The cached pool already contains a feasible replacement');};
  try {
    for (const count of [2, 3]) {
      const candidates = [place('first', 'culture'), place('second', 'culture'), place('third', 'culture'), {...place('new', 'culture'), affinity: 1}, {...place('newer', 'culture'), affinity: 1}, {...place('newest', 'culture'), affinity: 1}];
      const checked = await checkPlan({ids: candidates.slice(0, count).map(stop => stop.id), input, venue, candidates, mode: 'live'});
      assert.ok(checked.itinerary);
      const previous = checked.itinerary;
      const result = await agentPlan({config, input, venue, candidates, previous, excludedIds: [], messages: [], request: {message: 'More culture'},
        turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'culture', category: 'culture', minimum: 1, operation: 'increase', strength: 'preference'}]})});
      assert.ok(result.itinerary, result.clarification);
      assert.equal(result.itinerary.stops.length, count);
      assert.equal(result.itinerary.stops.filter(stop => !previous.stops.some(old => old.id === stop.id)).length, 1);
      assert.equal(result.memory.stopCount, undefined, 'Keeping this route size does not fabricate an explicit user preference');
    }
  } finally {globalThis.fetch = original;}
});

test('a relative taste never drops explicit required stops or falsely blames the saved total count', async () => {
  const candidates = [place('gallery', 'culture'), place('cafe-a', 'food'), place('cafe-b', 'food'), place('new-gallery', 'culture')];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'food', category: 'food', minimum: 2, strength: 'required', ids: ['cafe-a', 'cafe-b']}], undefined, {minimum: 3, maximum: 3});
  const snapshot = structuredClone(memory);
  const original = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') {
      searches++;
      return new Response(JSON.stringify({output: [{type: 'function_call', name: 'find_places', call_id: `search-${searches}`, arguments: JSON.stringify({query: 'art gallery', preference_query: 'culture'})}]}));
    }
    return new Response(JSON.stringify({results: {entities: [], tags: []}}));
  };
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'More culture'},
      turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'culture', category: 'culture', minimum: 1, operation: 'increase', strength: 'preference'}]})});
    assert.equal(result.itinerary, undefined);
    assert.deepEqual(result.memory, snapshot);
    assert.match(result.clarification!, /replacement into your 3-stop plan/);
    assert.match(result.clarification!, /keeping 2 food stops/);
    assert.doesNotMatch(result.clarification!, /could not fit 3 stops/);
    assert.ok(searches <= 2, 'Discovery stays bounded');
  } finally {globalThis.fetch = original;}
});


test('a broad increase does not multiply an earlier narrower required dining facet', async () => {
  const fine: Place = {...place('fine', 'food'), durationMinutes: 90, diningEvidence: {fineDining: true}};
  const candidates = [fine, place('cafe', 'food'), place('park', 'outdoors'), place('new-cafe', 'food')];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'food', category: 'food', diningStyle: 'fine_dining', minimum: 1, strength: 'required', ids: [fine.id]}], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('The checked candidate pool already satisfies both tastes');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'More food'},
      turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'food', category: 'food', minimum: 1, operation: 'increase', strength: 'preference'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.equal(result.itinerary.stops.length, 3);
    assert.ok(result.itinerary.stops.every(stop => stop.category === 'food'));
    assert.ok(result.itinerary.stops.some(stop => stop.id === fine.id));
    assert.equal(result.memory.preferences.find(group => group.diningStyle === 'fine_dining')?.minimum, 1);
    assert.equal(result.memory.preferences.find(group => !group.diningStyle)?.minimum, 3);
  } finally {globalThis.fetch = original;}
});


test('repeated relative refinements prefer cached unseen replacements instead of cycling earlier places', async () => {
  const candidates = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map((id, index) => ({...place(id, 'culture'), affinity: 1 - index * .1}));
  let previous = await current(candidates);
  let memory = rememberPlan(createRevisionMemory(previous), previous, [], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('A cached unseen matching replacement must not call a provider');};
  try {
    for (let turn = 0; turn < 3; turn++) {
      const alreadyShown = new Set(memory.shown.map(stop => stop.id));
      const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'More culture'},
        turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'culture', category: 'culture', minimum: 1, operation: 'increase', strength: 'preference'}]})});
      assert.ok(result.itinerary, result.clarification);
      const additions = result.itinerary.stops.filter(stop => !previous.stops.some(old => old.id === stop.id));
      assert.equal(additions.length, 1, 'Unrelated places remain in the current outing');
      assert.ok(!alreadyShown.has(additions[0]!.id), 'Use an unseen match while one fits instead of returning an earlier replacement');
      assert.equal(result.itinerary.stops.length, 3);
      assert.ok(result.itinerary.stops.every(stop => stop.category === 'culture'));
      assert.deepEqual(result.itinerary.input, input);
      assert.deepEqual(result.memory.stopCount, {minimum: 3, maximum: 3});
      assert.deepEqual(result.excludedIds, []);
      previous = result.itinerary;
      memory = result.memory;
    }
    assert.equal(memory.plans.length, 4);
  } finally {globalThis.fetch = original;}
});

test('keeping current places after a soft rebalance does not promote a stale matching aspiration', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('gallery-c', 'culture'), place('cafe', 'food')];
  const initialInput: PlanInput = {...input, budget: 'high'};
  const checked = await checkPlan({ids: candidates.slice(0, 3).map(stop => stop.id), input: initialInput, venue, candidates, mode: 'live'});
  assert.ok(checked.itinerary);
  const initial = checked.itinerary;
  const memory = rememberPlan(createRevisionMemory(initial), initial,
    [{query: 'culture', category: 'culture', minimum: 3, strength: 'preference', ids: candidates.slice(0, 3).map(stop => stop.id)}], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Both typed revisions fit the accepted local pool');};
  try {
    const rebalanced = await agentPlan({config, input: initialInput, venue, candidates, previous: initial, memory, excludedIds: [], messages: [], request: {message: 'More food'},
      turnIntent: defaultTurnIntent({kind: 'adjust', placeRequests: [{query: 'food', category: 'food', minimum: 1, operation: 'increase', strength: 'preference'}]})});
    assert.ok(rebalanced.itinerary, rebalanced.clarification);
    assert.equal(rebalanced.itinerary.stops.filter(stop => stop.category === 'culture').length, 2);
    assert.equal(rebalanced.memory.preferences.find(group => group.query === 'culture')!.minimum, 3, 'An old qualitative aspiration remains soft in memory');
    const kept = await agentPlan({config, input: rebalanced.itinerary.input, venue, candidates: rebalanced.candidates, previous: rebalanced.itinerary, memory: rebalanced.memory,
      excludedIds: [], messages: [], request: {message: 'Keep both cultural stops and make it cheaper'},
      turnIntent: defaultTurnIntent({kind: 'adjust', keepPreferences: ['culture'], budgetUpdate: 'low'})});
    assert.ok(kept.itinerary, kept.clarification);
    assert.deepEqual(kept.itinerary.stops.map(stop => stop.id), rebalanced.itinerary.stops.map(stop => stop.id), 'Keeping the two current cultural places must not bring back a third and remove the café');
    assert.equal(kept.itinerary.stops.filter(stop => stop.category === 'food').length, 1);
    assert.equal(kept.itinerary.input.budget, 'low');
    assert.deepEqual(kept.itinerary.input, {...initialInput, budget: 'low'});
    const culture = kept.memory.preferences.find(group => group.query === 'culture')!;
    assert.equal(culture.strength, 'required');
    assert.equal(culture.minimum, 2, 'The keep instruction binds actual current matches, not the stale soft target of three');
    assert.deepEqual(kept.memory.stopCount, {minimum: 3, maximum: 3});
  } finally {globalThis.fetch = original;}
});


test('a typed single-stop swap binds the requested kind and preserves every other ID and position', async () => {
  const candidates = [place('target-gallery', 'culture'), place('keep-gallery', 'culture'), place('keep-cafe', 'food'),
    {...place('replacement-cafe', 'food'), affinity: .1}, {...place('tempting-gallery', 'culture'), affinity: 1}, {...place('tempting-park', 'outdoors'), affinity: 1}];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'culture', category: 'culture', minimum: 1, strength: 'required', ids: ['target-gallery', 'keep-gallery']}], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('A typed atomic replacement already fits the accepted pool');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'Replace the first stop with a café and keep the others'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: previous.stops[0]!.id, placeRequests: [{query: 'cafe', category: 'food', minimum: 1, strength: 'preference'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['replacement-cafe', 'keep-gallery', 'keep-cafe']);
    assert.equal(result.itinerary.stops.length, 3);
    assert.deepEqual(result.itinerary.input, input);
    assert.deepEqual(result.memory.stopCount, {minimum: 3, maximum: 3});
    assert.equal(result.memory.preferences.find(group => group.query === 'culture')!.strength, 'required');
    assert.equal(result.memory.preferences.find(group => group.query === 'culture')!.minimum, 1);
    assert.deepEqual(result.excludedIds, ['target-gallery']);
    assert.equal(result.memory.plans.length, 2);
  } finally {globalThis.fetch = original;}
});

test('a typed swap cannot target a known candidate outside the current route', async () => {
  const candidates = [place('gallery', 'culture'), place('cafe', 'food'), place('bookstore', 'shop'), place('not-current', 'culture')];
  const previous = await current(candidates);
  const memory = createRevisionMemory(previous);
  const savedMemory = structuredClone(memory);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('An invalid atomic target must clarify before discovery');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'Replace that earlier gallery'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: 'not-current'})});
    assert.equal(result.itinerary, undefined);
    assert.match(result.clarification!, /current stop/);
    assert.deepEqual(result.memory, savedMemory);
    assert.equal(result.candidates, candidates);
    assert.deepEqual(result.excludedIds, []);
  } finally {globalThis.fetch = original;}
});

test('an atomic swap cannot satisfy a budget change by silently replacing an unrelated expensive stop', async () => {
  const candidates = [place('target-gallery', 'culture'), {...place('keep-expensive-cafe', 'food'), costTier: 3 as const}, place('keep-shop', 'shop'), place('new-gallery', 'culture'), place('cheap-cafe', 'food')];
  const initialInput: PlanInput = {...input, budget: 'high'};
  const checked = await checkPlan({ids: candidates.slice(0, 3).map(stop => stop.id), input: initialInput, venue, candidates, mode: 'live'});
  assert.ok(checked.itinerary);
  const previous = checked.itinerary;
  const memory = rememberPlan(createRevisionMemory(previous), previous, [], undefined, {minimum: 3, maximum: 3});
  const savedMemory = structuredClone(memory);
  const original = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') {
      searches++;
      return new Response(JSON.stringify({output: [{type: 'function_call', name: 'find_places', call_id: `atomic-search-${searches}`, arguments: JSON.stringify({query: 'art gallery', preference_query: null})}]}));
    }
    return new Response(JSON.stringify({results: {entities: [], tags: []}}));
  };
  try {
    const result = await agentPlan({config: {...config, qlooApiKey: 'atomic-budget-test'}, input: initialInput, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'Swap the first stop, keep the others, and make it cheaper'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: previous.stops[0]!.id, budgetUpdate: 'low'})});
    assert.equal(result.itinerary, undefined);
    assert.match(result.clarification!, /replacement for/);
    assert.match(result.clarification!, /keeps the rest of your route/);
    assert.doesNotMatch(result.clarification!, /could not fit 3 stops/);
    assert.deepEqual(result.memory, savedMemory);
    assert.deepEqual(result.excludedIds, []);
    assert.deepEqual(previous.input, initialInput);
    assert.ok(searches <= 2);
  } finally {globalThis.fetch = original;}
});


test('keeping the other two instances during a swap does not freeze all three old matching places as a type requirement', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('gallery-c', 'culture'),
    place('gallery-d', 'culture'), place('bookstore', 'shop')];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'culture', category: 'culture', minimum: 3, strength: 'preference', ids: candidates.slice(0, 4).map(stop => stop.id)}], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('The complete instance-preserving swap and later type adjustment fit cached places');};
  try {
    const swapped = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [],
      request: {message: 'Swap the first stop. Keep the other two exactly as they are.'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: previous.stops[0]!.id, keepPreferences: ['culture']})});
    assert.ok(swapped.itinerary, swapped.clarification);
    assert.deepEqual(swapped.itinerary.stops.slice(1).map(stop => stop.id), previous.stops.slice(1).map(stop => stop.id));
    const kept = swapped.memory.preferences.find(group => group.query === 'culture')!;
    assert.equal(kept.strength, 'required');
    assert.equal(kept.minimum, 2, 'Only unaffected matching instances bind a soft keep; the removed slot is excluded');
    const next = await agentPlan({config, input: swapped.itinerary.input, venue, candidates: swapped.candidates, previous: swapped.itinerary, memory: swapped.memory,
      excludedIds: swapped.excludedIds, messages: [], request: {message: 'Keep three stops with at least one bookstore'},
      turnIntent: defaultTurnIntent({kind: 'adjust', stopCount: {minimum: 3, maximum: 3}, placeRequests: [{query: 'bookstore', category: 'shop', minimum: 1, strength: 'required'}]})});
    assert.ok(next.itinerary, next.clarification);
    assert.equal(next.itinerary.stops.length, 3);
    assert.equal(next.itinerary.stops.filter(stop => stop.category === 'culture').length, 2);
    assert.ok(next.itinerary.stops.some(stop => stop.id === 'bookstore'));
    assert.equal(next.memory.preferences.find(group => group.query === 'culture')!.minimum, 2);
    assert.deepEqual(next.memory.stopCount, {minimum: 3, maximum: 3});
    assert.deepEqual(next.itinerary.input, input);
  } finally {globalThis.fetch = original;}
});


test('a café replacement and a numeric whole-plan culture requirement apply to their separate scopes', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('gallery-c', 'culture'), place('new-cafe', 'food')];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'culture', category: 'culture', minimum: 3, strength: 'preference', ids: candidates.slice(0, 3).map(stop => stop.id)}], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Both scoped goals fit trusted cached places');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [],
      request: {message: 'Replace the first stop with a café and keep at least two cultural stops'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: previous.stops[0]!.id, placeRequests: [
        {query: 'cafe', category: 'food', scope: 'replacement', minimum: 1, strength: 'preference'},
        {query: 'culture', category: 'culture', scope: 'plan', minimum: 2, strength: 'required'},
      ]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['new-cafe', 'gallery-b', 'gallery-c']);
    assert.equal(result.memory.preferences.find(group => group.query === 'culture')!.minimum, 2);
    assert.equal(result.memory.preferences.find(group => group.query === 'culture')!.strength, 'required');
    assert.ok(result.memory.preferences.every(group => !Object.hasOwn(group, 'scope') && !Object.hasOwn(group, 'replacement') && !Object.hasOwn(group, 'turnSearch')), 'Per-turn binding metadata does not enter persistent preferences');
    assert.deepEqual(result.itinerary.input, input);
    assert.deepEqual(result.memory.stopCount, {minimum: 3, maximum: 3});
  } finally {globalThis.fetch = original;}
});

test('keeping unaffected instances cannot relax a previously explicit hard type minimum', async () => {
  const candidates = [place('gallery-a', 'culture'), place('gallery-b', 'culture'), place('gallery-c', 'culture'), place('new-cafe', 'food')];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'culture', category: 'culture', minimum: 3, strength: 'required', ids: candidates.slice(0, 3).map(stop => stop.id)}], undefined, {minimum: 3, maximum: 3});
  const savedMemory = structuredClone(memory);
  const original = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') {
      searches++;
      return new Response(JSON.stringify({output: [{type: 'function_call', name: 'find_places', call_id: `hard-keep-${searches}`, arguments: JSON.stringify({query: 'cafe', preference_query: 'cafe'})}]}));
    }
    return new Response(JSON.stringify({results: {entities: [], tags: []}}));
  };
  try {
    const result = await agentPlan({config: {...config, qlooApiKey: 'atomic-hard-keep-test'}, input, venue, candidates, previous, memory, excludedIds: [], messages: [],
      request: {message: 'Replace the first stop with a café and keep the others'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: previous.stops[0]!.id, keepPreferences: ['culture'],
        placeRequests: [{query: 'cafe', category: 'food', scope: 'replacement', minimum: 1, strength: 'preference'}]})});
    assert.equal(result.itinerary, undefined, 'An old explicit three-culture requirement cannot silently become two');
    assert.deepEqual(result.memory, savedMemory);
    assert.equal(result.memory.preferences[0]!.minimum, 3);
    assert.deepEqual(result.excludedIds, []);
    assert.match(result.clarification!, /replacement for/);
    assert.ok(searches <= 2);
  } finally {globalThis.fetch = original;}
});

test('a spurious atomic keep for only the replaced slot does not create an unrelated hard taste', async () => {
  const candidates = [place('target-gallery', 'culture'), place('keep-cafe', 'food'), place('keep-bookstore', 'shop'), place('new-cafe', 'food')];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'culture', category: 'culture', minimum: 1, strength: 'preference', ids: ['target-gallery']}], undefined, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('The replacement is already verified in the local pool');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'Replace the first stop with a café and keep the others'},
      turnIntent: defaultTurnIntent({kind: 'adjust', replaceStopId: previous.stops[0]!.id, keepPreferences: ['culture'],
        placeRequests: [{query: 'cafe', category: 'food', scope: 'replacement', minimum: 1, strength: 'preference'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['new-cafe', 'keep-cafe', 'keep-bookstore']);
    assert.equal(result.memory.preferences.find(group => group.query === 'culture')!.strength, 'preference');
    assert.doesNotMatch(result.message ?? '', /Kept culture as required/);
  } finally {globalThis.fetch = original;}
});

test('clearing a shorter-walk preference keeps explicitly retained current places instead of reviving an old soft taste', async () => {
  const candidates = [place('culture-current', 'culture'), place('bookstore-current', 'shop'), {...place('shop-current', 'shop'), taxonomy: ['urn:tag:genre:place:clothing_store']}, {...place('culture-new', 'culture'), affinity: 1}];
  const previous = await current(candidates);
  const memory = rememberPlan(createRevisionMemory(previous), previous,
    [{query: 'culture', category: 'culture', minimum: 2, strength: 'preference', ids: ['culture-current', 'culture-new']}], 80, {minimum: 3, maximum: 3});
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('A configuration change retaining all current places needs no provider call');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'Remove the shorter-walk preference. Keep these same three places.'},
      turnIntent: defaultTurnIntent({kind: 'adjust', walking: 'clear_limit', keepStopIds: previous.stops.map(stop => stop.id)})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), previous.stops.map(stop => stop.id));
    assert.equal(result.memory.walkingLimit, undefined);
    assert.deepEqual(result.memory.stopCount, memory.stopCount);
    assert.equal(result.memory.preferences[0]?.minimum, 2);
    assert.equal(result.memory.preferences[0]?.strength, 'preference');
    assert.equal('keepStopIds' in result.memory, false, 'Kept instances do not lock subsequent turns.');
    assert.deepEqual(result.excludedIds, []);
  } finally {globalThis.fetch = original;}
});

test('keeping all current places with a conflicting lower budget guards instead of substituting an affordable stop', async () => {
  const highInput: PlanInput = {...input, budget: 'high'};
  const candidates: Place[] = [place('culture-current', 'culture'), {...place('expensive-current', 'food'), costTier: 3}, place('shop-current', 'shop'), place('affordable-new', 'food')];
  const checked = await checkPlan({ids: candidates.slice(0, 3).map(stop => stop.id), input: highInput, venue, candidates, mode: 'live'});
  assert.ok(checked.itinerary);
  const previous = checked.itinerary;
  const memory = rememberPlan(createRevisionMemory(previous), previous, [], undefined, {minimum: 3, maximum: 3});
  const snapshot = structuredClone(memory);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Fresh candidates cannot repair an unaffordable place that must be retained');};
  try {
    const result = await agentPlan({config, input: highInput, venue, candidates, previous, memory, excludedIds: [], messages: [], request: {message: 'Make the budget low, but keep all three places.'},
      turnIntent: defaultTurnIntent({kind: 'adjust', budgetUpdate: 'low', keepStopIds: previous.stops.map(stop => stop.id)})});
    assert.equal(result.itinerary, undefined);
    assert.match(result.clarification!, /could not keep all of these places/);
    assert.match(result.clarification!, /budget/);
    assert.deepEqual(result.memory, snapshot);
    assert.deepEqual(result.excludedIds, []);
    assert.equal(previous.input.budget, 'high');
  } finally {globalThis.fetch = original;}
});

test('retaining a subset binds those actual places while a new relative taste changes another place', async () => {
  const candidates = [place('keep-culture', 'culture'), place('keep-shop', 'shop'), place('replace-food', 'food'), {...place('new-culture', 'culture'), affinity: 1}];
  const previous = await current(candidates);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('A cached replacement satisfies the bound IDs and matching goal');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, excludedIds: [], messages: [], request: {message: 'More culture, but keep the gallery and bookstore.'},
      turnIntent: defaultTurnIntent({kind: 'adjust', keepStopIds: ['keep-culture', 'keep-shop'], placeRequests: [{query: 'culture', category: 'culture', minimum: 1, operation: 'increase', strength: 'preference', scope: 'plan'}]})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(new Set(result.itinerary.stops.map(stop => stop.id)), new Set(['keep-culture', 'keep-shop', 'new-culture']));
    assert.ok(!result.memory.preferences.some(group => group.ids.length === 2 && group.ids.includes('keep-shop')), 'The instance binding is not stored as a type preference.');
  } finally {globalThis.fetch = original;}
});

test('keeping every current place still allows a shorter order without discovering or replacing a place', async () => {
  const candidates = [
    {...place('middle', 'culture'), coordinates: {latitude: 40.755, longitude: -73.99}},
    {...place('near', 'shop'), coordinates: {latitude: 40.75, longitude: -73.991}},
    {...place('far', 'food'), coordinates: {latitude: 40.76, longitude: -73.99}},
  ];
  const previous = await current(candidates);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Reordering retained local stops needs no discovery');};
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, excludedIds: [], messages: [], request: {message: 'Less walking, but keep these three places.'},
      turnIntent: defaultTurnIntent({kind: 'adjust', walking: 'less', keepStopIds: previous.stops.map(stop => stop.id)})});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(new Set(result.itinerary.stops.map(stop => stop.id)), new Set(previous.stops.map(stop => stop.id)));
    assert.ok(result.itinerary.totalWalkMinutes < previous.totalWalkMinutes);
    assert.equal(result.memory.walkingLimit, result.itinerary.totalWalkMinutes);
  } finally {globalThis.fetch = original;}
});
