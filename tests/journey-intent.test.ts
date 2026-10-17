import assert from 'node:assert/strict';
import test from 'node:test';
import {applyPlaceScope, defaultTurnIntent, journeyMessage, validateTurnIntent, type StopCountBounds} from '../src/server/services/journey-intent.js';
import type {Itinerary} from '../src/shared/types.js';
import type {PlacePreference} from '../src/server/services/revision-memory.js';

const preferences: PlacePreference[] = [{query: 'culture', ids: ['museum'], minimum: 1, strength: 'required'}, {query: 'restaurant', ids: ['dinner'], minimum: 1, strength: 'preference'}];
const context = {message: 'Semantics are supplied by the interpreter.', currentCount: 1, preferences, trustedPlaceIds: ['museum', 'dinner'], currentPlaceIds: ['museum']};
test('typed update operations cannot enter the answer-only path, independently of wording', () => {
  for (const update of [{stopCount: {minimum: 3, maximum: 3}}, {placeScope: 'any' as const}, {dropPreferences: ['restaurant']}, {keepPreferences: ['restaurant']}, {walking: 'less' as const}, {showTimeUpdate: '19:00'}, {durationUpdate: 180}]) {
    const intent = validateTurnIntent(defaultTurnIntent(update), context);
    assert.equal(intent.kind, 'adjust'); assert.equal(intent.changesPlan, true);
  }
  const answer = validateTurnIntent(defaultTurnIntent({changesPlan: true}), context);
  assert.equal(answer.kind, 'answer'); assert.equal(answer.changesPlan, false);
  assert.equal(validateTurnIntent(defaultTurnIntent({kind: 'alternatives'}), context).minimumChanges, 1);
  const exclusive = validateTurnIntent(defaultTurnIntent({placeRequests: [{query: 'bookstore', minimum: 1, strength: 'preference', exclusive: true}]}), context);
  assert.equal(exclusive.placeRequests[0]?.strength, 'required'); assert.equal(exclusive.placeRequests[0]?.exclusive, true);
});
test('unsupported counts and unknown or contradictory references clarify without mutation', () => {
  for (const stopCount of [{minimum: 0, maximum: 3}, {minimum: 4, maximum: 4}, {minimum: 3, maximum: 2}, {minimum: 1.5, maximum: 3}] satisfies StopCountBounds[]) {
    const intent = validateTurnIntent(defaultTurnIntent({kind: 'adjust', stopCount}), context);
    assert.equal(intent.kind, 'clarify'); assert.equal(intent.changesPlan, false); assert.match(intent.clarification!, /one to three/);
  }
  for (const update of [{dropPreferences: ['invented']}, {restoreIds: ['invented']}, {keepPreferences: ['culture'], dropPreferences: ['culture']}, {rejectIds: ['museum'], restoreIds: ['museum']}]) {
    assert.equal(validateTurnIntent(defaultTurnIntent({kind: 'adjust', ...update}), context).kind, 'clarify');
  }
});
test('taste scope preserves mandatory preferences until a deliberate reset or semantic withdrawal', () => {
  const any = validateTurnIntent(defaultTurnIntent({placeScope: 'any'}), context);
  assert.deepEqual(applyPlaceScope(preferences, any).map(group => group.query), ['culture']);
  const reset = validateTurnIntent(defaultTurnIntent({placeScope: 'reset', keepPreferences: ['Restaurant']}), context);
  const kept = applyPlaceScope(preferences, reset);
  assert.deepEqual(kept.map(group => group.query), ['restaurant']); assert.equal(kept[0]?.strength, 'required'); assert.equal(kept[0]?.minimum, 1);
  const withdrawal = validateTurnIntent(defaultTurnIntent({dropPreferences: ['culture']}), context);
  assert.deepEqual(applyPlaceScope(preferences, withdrawal).map(group => group.query), ['restaurant']);
  assert.equal(preferences[1]?.strength, 'preference', 'Memory is not mutated by validation or scope application');
  const cleared = validateTurnIntent(defaultTurnIntent({stopCount: null}), context);
  assert.equal(cleared.kind, 'adjust'); assert.equal(cleared.stopCount, null);
});
test('reply helpers never acknowledge an unmet typed count as successful', () => {
  const intent = validateTurnIntent(defaultTurnIntent({stopCount: {minimum: 3, maximum: 3}, placeScope: 'any'}), context);
  const itinerary = {stops: [{id: 'museum'}]} as unknown as Itinerary;
  assert.equal(journeyMessage(intent, itinerary), undefined);
  assert.match(journeyMessage(intent, {...itinerary, stops: [{id: 'museum'}, {id: 'dinner'}, {id: 'other'}]} as Itinerary)!, /3 stops/);
});


test('atomic replacement targets must belong to the current route, not merely trusted candidates', () => {
  const replacement = validateTurnIntent(defaultTurnIntent({replaceStopId: 'museum'}), context);
  assert.equal(replacement.kind, 'adjust');
  assert.equal(replacement.replaceStopId, 'museum');
  assert.equal(replacement.minimumChanges, 1);
  for (const replaceStopId of ['dinner', 'invented']) {
    const rejected = validateTurnIntent(defaultTurnIntent({kind: 'adjust', replaceStopId}), context);
    assert.equal(rejected.kind, 'clarify');
    assert.match(rejected.clarification!, /current stop/);
    assert.equal(rejected.replaceStopId, undefined);
    assert.equal(rejected.changesPlan, false);
  }
});


test('replacement-scoped kinds require a current atomic target while whole-plan kinds remain independent', () => {
  const request = {query: 'cafe', category: 'food' as const, scope: 'replacement' as const, minimum: 1, strength: 'preference' as const};
  const missing = validateTurnIntent(defaultTurnIntent({kind: 'adjust', placeRequests: [request]}), context);
  assert.equal(missing.kind, 'clarify');
  assert.match(missing.clarification!, /current stop/);
  const valid = validateTurnIntent(defaultTurnIntent({kind: 'adjust', replaceStopId: 'museum', placeRequests: [request,
    {query: 'culture', category: 'culture', scope: 'plan', minimum: 1, strength: 'required'}]}), context);
  assert.equal(valid.kind, 'adjust');
  assert.deepEqual(valid.placeRequests.map(place => place.scope), ['replacement', 'plan']);
});


test('retained stop instances are copied without creating persistent taste requirements', () => {
  const kept = ['museum'];
  const intent = defaultTurnIntent({kind: 'adjust', keepStopIds: kept, walking: 'clear_limit'});
  kept.push('dinner');
  assert.deepEqual(intent.keepStopIds, ['museum'], 'The semantic intent owns a copy of its current-instance IDs.');
  const before = structuredClone(intent);
  const result = validateTurnIntent(intent, context);
  assert.deepEqual(intent, before);
  assert.deepEqual(result.keepStopIds, ['museum']);
  assert.notEqual(result.keepStopIds, intent.keepStopIds);
  assert.deepEqual(result.keepPreferences, []);
  assert.deepEqual(result.placeRequests, []);
  assert.equal(result.walking, 'clear_limit');
  assert.deepEqual(defaultTurnIntent().keepStopIds, []);
});

test('retention accepts only current instances and rejects conflicts with replacing or rejecting them', () => {
  for (const update of [{keepStopIds: ['dinner']}, {keepStopIds: ['invented']}, {keepStopIds: ['museum'], replaceStopId: 'museum'}, {keepStopIds: ['museum'], rejectIds: ['museum']}]) {
    const intent = defaultTurnIntent({kind: 'adjust', ...update});
    const before = structuredClone(intent);
    const result = validateTurnIntent(intent, context);
    assert.equal(result.kind, 'clarify');
    assert.equal(result.changesPlan, false);
    assert.deepEqual(intent, before, 'Invalid instance constraints cannot mutate the original accepted operations.');
  }
});

test('keeping current places during a read-only question does not promote it to a plan adjustment', () => {
  const intent = defaultTurnIntent({kind: 'answer', keepStopIds: ['museum']});
  const before = structuredClone(intent);
  const result = validateTurnIntent(intent, {...context, message: 'Keep these places; is budget on?'});
  assert.equal(result.kind, 'answer');
  assert.equal(result.changesPlan, false);
  assert.deepEqual(result.keepStopIds, ['museum']);
  assert.equal(result.budgetUpdate, 'unchanged');
  assert.deepEqual(result.placeRequests, []);
  assert.deepEqual(intent, before);
});
