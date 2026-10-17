import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, PlanInput, Venue } from '../src/shared/types.js';
import { checkPlan, suggestStopIds, type PlanPreferences } from '../src/server/services/planner.js';
import { createRevisionMemory, rememberPlan, type PlacePreference } from '../src/server/services/revision-memory.js';

const venue: Venue = {id: 'venue', name: 'Venue', city: 'New York', address: '100 Test Street, New York, NY', coordinates: {latitude: 40.72, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-30', showTime: '18:30', durationMinutes: 180, startingPoint: 'venue'};
const places: Place[] = ['A', 'B', 'C', 'D'].map((id, index) => ({id, name: `${id} Records`, category: 'shop', address: `${index + 1} Test Street, New York, NY`,
  coordinates: {latitude: 40.721 + index * .0002, longitude: -73.991}, description: 'Used jazz records and local music zines.', durationMinutes: 20,
  taxonomy: ['urn:tag:genre:place:record_store'], affinity: 1 - index * .3}));

test('alternatives require a fresh actual place, not an identical plan, reordered stops or a previously shown substitute', async () => {
  const initial = await checkPlan({ids: ['A', 'B', 'C'], input, venue, candidates: places, mode: 'sample'});
  assert.ok(initial.itinerary);
  const memory = createRevisionMemory(initial.itinerary);
  const preferences: PlanPreferences = {diversify: true, minimumChangedStops: 1, minimumUnseenStops: 1, seenIds: memory.shown.map(place => place.id)};
  for (const ids of [['A', 'B', 'C'], ['C', 'B', 'A']]) {
    const unchanged = await checkPlan({ids, input, venue, candidates: places, mode: 'sample', previous: initial.itinerary, preferences});
    assert.equal(unchanged.valid, false);
    assert.ok(unchanged.issues.some(issue => issue.includes('actual places')));
  }
  const ids = suggestStopIds(input, venue, places, preferences, initial.itinerary);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes('D'), 'the lower-affinity fresh candidate must beat recycling only seen places');
  const alternative = await checkPlan({ids, input, venue, candidates: places, mode: 'sample', previous: initial.itinerary, preferences});
  assert.ok(alternative.itinerary);
  const updated = rememberPlan(memory, alternative.itinerary);
  const currentIds = alternative.itinerary.stops.map(place => place.id);
  const oldSubstitute = ['A', 'B', 'C'].find(id => !currentIds.includes(id));
  assert.ok(oldSubstitute);
  const recycledIds = [oldSubstitute, ...currentIds.filter(id => id !== 'D')];
  const recycled = await checkPlan({ids: recycledIds, input, venue, candidates: places, mode: 'sample', previous: alternative.itinerary,
    preferences: {...preferences, seenIds: updated.shown.map(place => place.id)}});
  assert.equal(recycled.valid, false, 'an earlier shown place is not unseen merely because it left the current plan');
  assert.deepEqual(suggestStopIds(input, venue, places, {...preferences, seenIds: updated.shown.map(place => place.id)}, alternative.itinerary), []);
});

test('memory preserves preferences and a soft walking target, bounds history, and does not implicitly reject seen places', async () => {
  const initial = await checkPlan({ids: ['A', 'B', 'C'], input, venue, candidates: places, mode: 'sample'});
  assert.ok(initial.itinerary);
  const preferences: PlacePreference[] = [{query: 'record store', ids: ['A', 'A', 'D'], minimum: 1, matchedTagIds: ['urn:tag:genre:place:record_store']}];
  let memory = rememberPlan(createRevisionMemory(initial.itinerary), initial.itinerary, preferences, initial.itinerary.totalWalkMinutes);
  assert.equal(memory.plans.length, 1, 'accepting the same stops twice does not add duplicate history');
  const checked = await checkPlan({ids: ['A', 'B', 'C'], input, venue, candidates: places, mode: 'sample', previous: initial.itinerary,
    preferences: {preferredWalkMinutes: memory.walkingLimit, requiredPlaceGroups: memory.preferences}});
  assert.ok(checked.itinerary, 'a later adjustment may keep the accepted walking estimate equal');
  const overLimit = await checkPlan({ids: ['A', 'B', 'C'], input, venue, candidates: places, mode: 'sample', previous: initial.itinerary,
    preferences: {maximumWalkMinutes: memory.walkingLimit! - 1}});
  assert.equal(overLimit.valid, false);
  assert.deepEqual(suggestStopIds(input, venue, [places[0]!], {seenIds: memory.shown.map(place => place.id)}), ['A']);
  assert.deepEqual(suggestStopIds(input, venue, [places[0]!], {seenIds: memory.shown.map(place => place.id), excludeIds: ['A']}), []);
  for (let index = 0; index < 90; index++) memory = rememberPlan(memory, {...initial.itinerary, stops: [{...initial.itinerary.stops[0]!, id: `history-${index}`, name: `History ${index}`}]});
  assert.equal(memory.shown.length, 80);
  assert.equal(memory.plans.length, 6);
  assert.equal(memory.walkingLimit, initial.itinerary.totalWalkMinutes);
  assert.deepEqual(memory.preferences, [{...preferences[0], ids: ['A', 'D']}]);
  assert.deepEqual(preferences[0]?.ids, ['A', 'A', 'D'], 'recording memory must not mutate trusted preference inputs');
});
