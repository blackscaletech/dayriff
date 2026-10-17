import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultTurnIntent, type TurnIntent} from '../src/server/services/journey-intent.js';
import {reconcilePlacePolicy, type PlacePolicyFact} from '../src/server/services/place-policy.js';
import type {PlacePreference} from '../src/server/services/revision-memory.js';

const preferences: PlacePreference[] = [
  {query: 'culture', ids: ['museum'], category: 'culture', minimum: 1, strength: 'required'},
  {query: 'restaurant', ids: ['dinner'], category: 'food', minimum: 1, strength: 'required'},
];
const positive = (query: string, overrides: Partial<TurnIntent['placeRequests'][number]> = {}) => ({query, minimum: 1, strength: 'preference' as const, scope: 'plan' as const, ...overrides});
const exclusion = (query: string, overrides: Partial<TurnIntent['placeRequests'][number]> = {}) => positive(query, {minimum: 0, maximum: 0, strength: 'required', ...overrides});
const fact = (effect: PlacePolicyFact['effect'], query: string, quote: string, overrides: Partial<PlacePolicyFact> = {}): PlacePolicyFact => ({effect, query, quote, scope: 'plan', ...overrides});

function reconcile(intent: TurnIntent, facts: PlacePolicyFact[], message: string, active = preferences): TurnIntent {
  const before = structuredClone({intent, facts, active});
  const result = reconcilePlacePolicy(intent, facts, message, active);
  assert.deepEqual({intent, facts, active}, before, 'Reconciliation must not mutate the interpreted goal, evidence or remembered policy.');
  assert.notEqual(result, intent, 'The accepted intent is a new value.');
  return result;
}
function nonPlaceFields(intent: TurnIntent) {
  const {placeRequests: _requests, dropPreferences: _drops, keepPreferences: _keeps, ...fields} = intent;
  return fields;
}

test('a compound withdrawal and literal ban remove old requirements and preserve unrelated positive requests', () => {
  const message = 'Remove my culture preference, and no restaurants. More bookstores please.';
  const intent = defaultTurnIntent({kind: 'adjust', placeRequests: [positive('bookstore', {category: 'shop', operation: 'increase'})], dropPreferences: ['culture']});
  const result = reconcile(intent, [fact('withdraw', 'culture', 'Remove my culture preference', {activeQuery: 'culture'}),
    fact('exclude', 'restaurant', 'no restaurants', {activeQuery: 'restaurant', category: 'food'})], message);
  assert.deepEqual(new Set(result.dropPreferences), new Set(['culture', 'restaurant']));
  assert.deepEqual(result.placeRequests.find(request => request.query === 'bookstore'), intent.placeRequests[0]);
  const ban = result.placeRequests.find(request => request.query === 'restaurant');
  assert.equal(ban?.minimum, 0);
  assert.equal(ban?.maximum, 0);
  assert.equal(ban?.strength, 'required');
  assert.equal(ban?.scope, 'plan');
  assert.equal(ban?.category, 'food');
  assert.ok(!result.placeRequests.some(request => request.query === 'culture'), 'Withdrawing culture does not create a ban on cultural places.');
});

test('withdrawing a preference removes a model-invented ban instead of excluding the kind', () => {
  const message = 'I no longer need a restaurant.';
  const result = reconcile(defaultTurnIntent({kind: 'adjust', placeRequests: [exclusion('restaurant')], dropPreferences: ['restaurant']}),
    [fact('withdraw', 'restaurant', message, {activeQuery: 'restaurant'})], message);
  assert.deepEqual(result.dropPreferences, ['restaurant']);
  assert.deepEqual(result.keepPreferences, []);
  assert.deepEqual(result.placeRequests, [], 'A withdrawn requirement still permits that kind in future plans.');
});

test('do not remove preserves a positive requirement and prevents an erroneous semantic drop', () => {
  const message = 'Do not remove my culture preference; just make the walk shorter.';
  const intent = defaultTurnIntent({kind: 'adjust', dropPreferences: ['culture'], walking: 'less'});
  const result = reconcile(intent, [fact('preserve', 'culture', 'Do not remove my culture preference', {activeQuery: 'culture'})], message);
  assert.deepEqual(result.dropPreferences, []);
  assert.deepEqual(result.keepPreferences, ['culture']);
  assert.equal(result.walking, 'less');
  assert.deepEqual(result.placeRequests, []);
});

test('preserving an existing exclusion protects it without promoting it to a positive keep requirement', () => {
  const active: PlacePreference[] = [{query: 'restaurant', ids: ['dinner'], category: 'food', minimum: 0, maximum: 0, strength: 'required'}];
  const message = 'Keep avoiding restaurants.';
  const result = reconcile(defaultTurnIntent({kind: 'adjust', dropPreferences: ['restaurant']}),
    [fact('preserve', 'restaurant', message, {activeQuery: 'restaurant'})], message, active);
  assert.deepEqual(result.dropPreferences, []);
  assert.deepEqual(result.keepPreferences, []);
  assert.deepEqual(result.placeRequests, []);
});

test('a quoted past statement does not authorize a current ban, drop or keep without policy evidence', () => {
  const message = 'Earlier I said "no restaurants". Why is the museum a match?';
  const intent = defaultTurnIntent({kind: 'answer', placeRequests: [exclusion('restaurant')], dropPreferences: ['restaurant'], keepPreferences: ['culture']});
  const result = reconcile(intent, [], message);
  assert.deepEqual(result.placeRequests, []);
  assert.deepEqual(result.dropPreferences, []);
  assert.deepEqual(result.keepPreferences, []);
  assert.deepEqual(nonPlaceFields(result), nonPlaceFields(intent), 'The evidence boundary does not reinterpret the information request or change schedule fields.');
});

test('a replacement-only ban stays scoped to its target and leaves count, schedule, budget and other requests intact', () => {
  const message = 'Replace the first stop, but not with a restaurant. Keep the rest and arrive by 6 pm.';
  const intent = defaultTurnIntent({kind: 'adjust', replaceStopId: 'first-stop', minimumChanges: 1,
    stopCount: {minimum: 3, maximum: 3}, budgetUpdate: 'unset', showTimeUpdate: '19:30', durationUpdate: 240, arrivalUpdate: '18:00', walking: 'less',
    placeRequests: [positive('culture', {minimum: 2, strength: 'required', category: 'culture'})]});
  const result = reconcile(intent, [fact('exclude', 'restaurant', 'not with a restaurant', {scope: 'replacement', targetId: 'first-stop', category: 'food'})], message);
  assert.deepEqual(nonPlaceFields(result), nonPlaceFields(intent));
  assert.deepEqual(result.dropPreferences, [], 'A slot exclusion does not withdraw an independent whole-plan restaurant requirement.');
  assert.deepEqual(result.placeRequests.find(request => request.query === 'culture'), intent.placeRequests[0]);
  const ban = result.placeRequests.find(request => request.query === 'restaurant');
  assert.equal(ban?.scope, 'replacement');
  assert.equal(ban?.minimum, 0);
  assert.equal(ban?.maximum, 0);
  assert.equal(ban?.strength, 'required');
  assert.equal(result.replaceStopId, 'first-stop');
});

test('an explicit include reversal removes a remembered ban and keeps the authorized positive request', () => {
  const active: PlacePreference[] = [{query: 'restaurant', ids: [], minimum: 0, maximum: 0, strength: 'required', category: 'food'}];
  const message = 'Actually include a restaurant.';
  const include = positive('restaurant', {category: 'food', strength: 'required'});
  const intent = defaultTurnIntent({kind: 'adjust', placeRequests: [include, exclusion('restaurant')]});
  const result = reconcile(intent, [fact('include', 'restaurant', message, {activeQuery: 'restaurant', category: 'food'})], message, active);
  assert.deepEqual(result.dropPreferences, ['restaurant']);
  assert.deepEqual(result.placeRequests, [include]);
  assert.ok(result.placeRequests.every(request => request.maximum !== 0), 'An authorized reversal cannot retain the conflicting hard ban.');
});

test('multiple evidence-backed exclusions remain bounded and keep dining facets rather than broadening the ban', () => {
  const message = 'No fine dining and no bookstores.';
  const intent = defaultTurnIntent({kind: 'adjust', placeRequests: [exclusion('restaurant'), exclusion('bookstore'), exclusion('culture')]});
  const result = reconcile(intent, [fact('exclude', 'restaurant', 'No fine dining', {category: 'food', diningStyle: 'fine_dining'}),
    fact('exclude', 'bookstore', 'no bookstores', {category: 'shop'})], message, []);
  assert.equal(result.placeRequests.length, 2, 'Only independently evidenced bans survive.');
  assert.deepEqual(result.placeRequests.map(request => request.query).sort(), ['bookstore', 'restaurant']);
  assert.ok(result.placeRequests.every(request => request.minimum === 0 && request.maximum === 0 && request.strength === 'required' && request.scope === 'plan'));
  assert.equal(result.placeRequests.find(request => request.query === 'restaurant')?.diningStyle, 'fine_dining');
  assert.equal(result.placeRequests.find(request => request.query === 'bookstore')?.category, 'shop');
});

test('invalid evidence, inactive or mis-cased references, and mismatched replacement targets fail closed', () => {
  const message = 'No restaurants. Keep culture.';
  const intent = defaultTurnIntent({kind: 'adjust', replaceStopId: 'first-stop'});
  const invalid: PlacePolicyFact[] = [
    fact('exclude', 'restaurant', 'no restaurants'),
    fact('exclude', 'restaurant', ''),
    fact('exclude', 'restaurant', 'No restaurants', {activeQuery: 'invented'}),
    fact('preserve', 'culture', 'Keep culture', {activeQuery: 'Culture'}),
    fact('exclude', 'restaurant', 'No restaurants', {scope: 'replacement', targetId: 'another-stop'}),
    fact('exclude', 'restaurant', 'No restaurants', {scope: 'replacement'}),
  ];
  for (const evidence of invalid) assert.throws(() => reconcilePlacePolicy(intent, [evidence], message, preferences), {code: 'INVALID_PLACE_POLICY'});
});

test('conflicting evidence cannot authorize both inclusion and exclusion of the same scoped kind', () => {
  const message = 'No restaurants; include a restaurant.';
  const facts = [fact('exclude', 'restaurant', 'No restaurants'), fact('include', 'restaurant', 'include a restaurant')];
  assert.throws(() => reconcilePlacePolicy(defaultTurnIntent({kind: 'adjust', placeRequests: [positive('restaurant')]}), facts, message, []), {code: 'INVALID_PLACE_POLICY'});
});

test('policy evidence is bounded to four facts and short nonempty queries', () => {
  const message = 'No food; no shops; no culture; no outdoors; no bookstores.';
  const facts = [fact('exclude', 'food', 'No food'), fact('exclude', 'shop', 'no shops'), fact('exclude', 'culture', 'no culture'), fact('exclude', 'outdoors', 'no outdoors')];
  const intent = defaultTurnIntent({kind: 'adjust'});
  const result = reconcile(intent, facts, message, []);
  assert.equal(result.placeRequests.length, 4);
  assert.throws(() => reconcilePlacePolicy(intent, [...facts, fact('exclude', 'bookstore', 'no bookstores')], message, []), {code: 'INVALID_PLACE_POLICY'});
  for (const query of ['', 'x'.repeat(71)]) {
    assert.throws(() => reconcilePlacePolicy(intent, [fact('exclude', query, 'No food')], message, []), {code: 'INVALID_PLACE_POLICY'});
  }
});

test('a broad refusal replaces an old faceted requirement without narrowing the new exclusion', () => {
  const active: PlacePreference[] = [{query: 'restaurant', ids: ['dinner'], minimum: 1, strength: 'required', category: 'food', diningStyle: 'high_end', recognition: 'michelin'}];
  const message = 'No restaurants now; include an outdoor stop.';
  const result = reconcile(defaultTurnIntent({kind: 'adjust', placeRequests: [positive('outdoors', {category: 'outdoors'})]}),
    [fact('exclude', 'restaurant', 'No restaurants now', {activeQuery: 'restaurant', category: 'food'})], message, active);
  assert.deepEqual(result.dropPreferences, ['restaurant']);
  const ban = result.placeRequests.find(request => request.maximum === 0)!;
  assert.equal(ban.query, 'restaurant');
  assert.equal(ban.diningStyle, undefined, 'The old high-end facet must not leak into an all-restaurant ban.');
  assert.equal(ban.recognition, undefined);
  assert.equal(ban.category, 'food');
});

test('a narrow replacement refusal keeps its own facets and cannot edit whole-plan requirements', () => {
  const active: PlacePreference[] = [{query: 'restaurant', ids: ['dinner'], minimum: 1, strength: 'required', category: 'food'}];
  const message = 'Replace the first stop, but avoid fine dining for that replacement.';
  const result = reconcile(defaultTurnIntent({kind: 'adjust', replaceStopId: 'first'}),
    [fact('exclude', 'restaurant', 'avoid fine dining for that replacement', {scope: 'replacement', targetId: 'first', category: 'food', diningStyle: 'fine_dining'})], message, active);
  assert.deepEqual(result.dropPreferences, []);
  assert.equal(result.placeRequests[0]?.scope, 'replacement');
  assert.equal(result.placeRequests[0]?.diningStyle, 'fine_dining');
});

test('withdrawing a requirement removes an accidentally repeated matching request', () => {
  const message = 'No need for a restaurant now.';
  const result = reconcile(defaultTurnIntent({kind: 'adjust', placeRequests: [positive('restaurant')]}),
    [fact('withdraw', 'restaurant', message, {activeQuery: 'restaurant'})], message);
  assert.deepEqual(result.dropPreferences, ['restaurant']);
  assert.deepEqual(result.placeRequests, []);
});

test('a policy selector cannot silently substitute an unrelated active category', () => {
  const message = 'No bookstores now.';
  assert.throws(() => reconcilePlacePolicy(defaultTurnIntent({kind: 'adjust'}),
    [fact('exclude', 'bookstore', message, {activeQuery: 'restaurant', category: 'shop'})], message, preferences), {code: 'INVALID_PLACE_POLICY'});
});

test('contradictory withdrawal and preservation of an existing exclusion fail closed', () => {
  const message = 'Keep avoiding restaurants. Remove that preference.';
  const active: PlacePreference[] = [{query: 'restaurant', ids: [], minimum: 0, maximum: 0, category: 'food', strength: 'required'}];
  assert.throws(() => reconcilePlacePolicy(defaultTurnIntent({kind: 'adjust'}),
    [fact('preserve', 'restaurant', 'Keep avoiding restaurants', {activeQuery: 'restaurant'}), fact('withdraw', 'restaurant', 'Remove that preference', {activeQuery: 'restaurant'})], message, active), {code: 'INVALID_PLACE_POLICY'});
});
