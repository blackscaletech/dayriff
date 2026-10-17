import assert from 'node:assert/strict';
import test from 'node:test';
import type { Itinerary, Place, PlanInput, Venue } from '../src/shared/types.js';
import { budgetAllows, checkPlan, maximumMinutes, suggestStopIds } from '../src/server/services/planner.js';
import {derivePlanningWindow} from '../src/shared/planning-window.js';
import { planInputSchema } from '../src/server/validation.js';
import { knownRevisionPreferences, sampleRevision } from '../src/server/services/revisions.js';
import { placeCategory, searchArtists } from '../src/server/providers/qloo.js';

const venue: Venue = {id: 'venue', name: 'Venue', city: 'Test City', address: 'Test address', coordinates: {latitude: 40.72, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-30', showTime: '18:30', durationMinutes: 180, startingPoint: 'venue'};
const place: Place = {id: 'place', name: 'A nearby place', category: 'culture', address: 'Test address', coordinates: {latitude: 40.721, longitude: -73.991}, description: 'Test place', durationMinutes: 25};

test('optional inputs remain absent while the arrival target preserves the full outing window', () => {
  assert.equal(maximumMinutes(input), 180);
  assert.equal(budgetAllows(place), true);
  assert.equal(budgetAllows(place, 'low'), false);
  assert.equal(maximumMinutes({...input, arrivalBy: '16:00'}), 180);
  const parsed = planInputSchema.parse({...input, arrivalBy: '', budget: null});
  assert.equal(parsed.arrivalBy, undefined);
  assert.equal(parsed.budget, undefined);
});
test('rejects impossible calendar dates and an arrival after the show', () => {
  assert.equal(planInputSchema.safeParse({...input, date: '2026-02-31'}).success, false);
  assert.equal(planInputSchema.safeParse({...input, arrivalBy: '19:00'}).success, false);
});
test('candidate IDs and hard timing limits remain authoritative', async () => {
  const unknown = await checkPlan({ids: ['invented-place'], input, venue, candidates: [place], mode: 'sample'});
  assert.equal(unknown.valid, false);
  const chain = {...place, name: 'Starbucks Coffee'};
  const generic = await checkPlan({ids: [chain.id], input, venue, candidates: [chain], mode: 'live'});
  assert.equal(generic.valid, false);
  assert.equal(suggestStopIds(input, venue, [chain]).length, 0);
  const rushed = await checkPlan({ids: [place.id], input: {...input, durationMinutes: 30}, venue, candidates: [{...place, durationMinutes: 35}], mode: 'sample'});
  assert.equal(rushed.valid, false);
});
test('approximate routes are labeled and never claimed to satisfy less walking without improvement', async () => {
  const result = await checkPlan({ids: [place.id], input, venue, candidates: [place], mode: 'sample'});
  assert.ok(result.itinerary);
  assert.ok(result.itinerary.notices.some(notice => notice.includes('approximate')));
  const unchanged = await checkPlan({ids: [place.id], input, venue, candidates: [place], mode: 'sample', previous: result.itinerary, preferences: {lessWalking: true}});
  assert.equal(unchanged.valid, false);
  const nearby = [1, 2, 3].map(index => ({...place, id: `nearby-${index}`, durationMinutes: 15}));
  const previousThree = {...result.itinerary, totalWalkMinutes: 100, stops: nearby.map(item => ({...result.itinerary!.stops[0]!, ...item}))};
  assert.equal(suggestStopIds(input, venue, nearby, {lessWalking: true}, previousThree).length, 3, 'Keep three stops when a shorter three-stop route fits');
});
test('sample follow-ups apply explicit arrival and ask for unsupported changes', async () => {
  const {itinerary} = await checkPlan({ids: [place.id], input, venue, candidates: [place], mode: 'sample'});
  assert.ok(itinerary);
  assert.equal(sampleRevision(itinerary, {message: 'Get me to the venue by 6 pm'}, []).input.arrivalBy, '18:00');
  assert.equal(sampleRevision(itinerary, {message: 'Get me to the venue by 7'}, []).input.arrivalBy, undefined);
  assert.ok(sampleRevision(itinerary, {message: 'Book a helicopter'}, []).clarification);
  const negated = sampleRevision(itinerary, {message: 'Less walking but not cheaper'}, []);
  assert.ok(negated.clarification);
  assert.equal(negated.input.budget, undefined);
  const budgetPlan = {...itinerary, input: {...input, budget: 'medium' as const}};
  assert.equal(sampleRevision(budgetPlan, {message: 'My budget limit is higher'}, []).input.budget, 'medium');
  assert.equal(sampleRevision(budgetPlan, {message: 'Remove the budget preference'}, []).input.budget, undefined);
});
test('sample duration edits accept common wording and backtrack while preserving show and arrival preferences', async () => {
  const {itinerary} = await checkPlan({ids: [place.id], input, venue, candidates: [place], mode: 'sample'});
  assert.ok(itinerary);
  for (const arrivalBy of [undefined, '18:15']) {
    const previous: Itinerary = {...itinerary, input: {...input, ...(arrivalBy ? {arrivalBy} : {})}};
    for (const [message, duration, defaultStart, explicitStart] of [['Make it 2 hours', 120, '16:00', '16:15'], ['I have 2 hours', 120, '16:00', '16:15'], ['Make it 90 minutes', 90, '16:30', '16:45']] as const) {
      const result = sampleRevision(previous, {message}, []);
      assert.equal(result.clarification, undefined, message);
      assert.equal(result.input.durationMinutes, duration);
      assert.equal(result.input.showTime, input.showTime);
      assert.equal(result.input.arrivalBy, arrivalBy);
      assert.equal(result.input.budget, undefined);
      assert.equal(derivePlanningWindow(result.input).startTime, arrivalBy ? explicitStart : defaultStart);
      assert.deepEqual(previous.input, {...input, ...(arrivalBy ? {arrivalBy} : {})});
    }
  }
});
test('sample duration edits clarify invalid allowances and do not confuse the show length with exploration time', async () => {
  const {itinerary} = await checkPlan({ids: [place.id], input, venue, candidates: [place], mode: 'sample'});
  assert.ok(itinerary);
  for (const message of ['Make it 9 hours', 'I have 20 minutes', 'The show lasts 2 hours']) {
    const result = sampleRevision(itinerary, {message}, []);
    assert.ok(result.clarification, message);
    assert.deepEqual(result.input, itinerary.input, message);
  }
});
test('malformed Qloo envelopes fail safely rather than becoming sample results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({unexpected: 'payload'}), {status: 200, headers: {'Content-Type': 'application/json'}});
  try {
    await assert.rejects(searchArtists({qlooApiKey: 'test-only', qlooApiUrl: 'https://api.qloo.com'}, 'Artist'), /unexpected response/);
  } finally { globalThis.fetch = originalFetch; }
});

test('Qloo place classification ignores amenity tags in both endpoint shapes', () => {
  assert.equal(placeCategory({tags: [
    {tag_id: 'urn:tag:category:place:museum', type: 'urn:tag:category:place', name: 'Museum'},
    {tag_id: 'urn:tag:amenity:place:cafe', type: 'urn:tag:amenity:place', name: 'Cafe'},
  ]}), 'culture');
  assert.equal(placeCategory({tags: [
    {id: 'urn:tag:genre:place:art_gallery', type: 'urn:tag:genre:place', name: 'Art gallery'},
    {id: 'urn:tag:amenity:place:gift_shop', type: 'urn:tag:amenity:place', name: 'Gift shop'},
  ]}), 'culture');
  assert.equal(placeCategory({tags: ['urn:tag:genre:place:record_store']}), 'shop');
  assert.equal(knownRevisionPreferences(undefined, 'Less walking, please. Keep three stops if possible.').lessWalking, true);
  assert.equal(knownRevisionPreferences(undefined, 'Do not use less walking.').lessWalking, undefined);
});


test('a verified custom origin changes the first leg, route origin and timing, while the concert remains the destination', async () => {
  const start = {name: 'Starting address', address: '126 Crosby St, New York', coordinates: {latitude: 40.7246, longitude: -73.9966}};
  const atVenue = await checkPlan({ids: [place.id], input, venue, candidates: [place], mode: 'live'});
  const custom = await checkPlan({ids: [place.id], input: {...input, startingPoint: '126 Crosby St'}, venue, startingLocation: start, candidates: [place], mode: 'live'});
  assert.ok(custom.itinerary && atVenue.itinerary);
  assert.deepEqual(custom.itinerary.startingLocation, start);
  assert.notEqual(custom.itinerary.stops[0]?.walkMinutes, atVenue.itinerary.stops[0]?.walkMinutes);
  const route = new URL(custom.itinerary.routeUrl);
  assert.match(route.searchParams.get('origin')!, /126 Crosby St/);
  assert.match(route.searchParams.get('destination')!, /Venue/);
  assert.match(new URL(custom.itinerary.stops[0]!.directionsUrl!).searchParams.get('origin')!, /126 Crosby St/);
  const revised = await checkPlan({ids: [place.id], input: custom.itinerary.input, venue, previous: custom.itinerary, candidates: [place], mode: 'live'});
  assert.deepEqual(revised.itinerary?.startingLocation, start);
  assert.equal(planInputSchema.parse({...input, startingPoint: ''}).startingPoint, 'Near the venue');
  const remote = await checkPlan({ids: [place.id], input, venue, startingLocation: {...start, coordinates: {latitude: 41, longitude: -74}}, candidates: [place], mode: 'live'});
  assert.equal(remote.valid, false);
});

test('single-stop replacement preserves the other slots and count at both ranking and validation boundaries', async () => {
  const candidates = [0, 1, 2, 3].map(index => ({...place, id: `swap-${index}`, name: `Local Gallery ${index}`, durationMinutes: 20,
    coordinates: {latitude: 40.7202 + index * .0001, longitude: -73.99}}));
  const checked = await checkPlan({ids: candidates.slice(0, 3).map(item => item.id), input, venue, candidates, mode: 'live'});
  assert.ok(checked.itinerary);
  const preferences = {replaceStopId: candidates[1]!.id, excludeIds: [candidates[1]!.id]};
  const suggested = suggestStopIds(input, venue, candidates, preferences, checked.itinerary);
  assert.deepEqual(suggested, [candidates[0]!.id, candidates[3]!.id, candidates[2]!.id]);
  const valid = await checkPlan({ids: suggested, input, venue, candidates, mode: 'live', previous: checked.itinerary, preferences});
  assert.ok(valid.itinerary);
  for (const ids of [[candidates[3]!.id], [candidates[3]!.id, candidates[0]!.id, candidates[2]!.id]]) {
    const invalid = await checkPlan({ids, input, venue, candidates, mode: 'live', previous: checked.itinerary, preferences});
    assert.equal(invalid.valid, false, 'Dropping or moving unaffected stops must fail');
  }
});
