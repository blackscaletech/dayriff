import assert from 'node:assert/strict';
import test from 'node:test';
import type {Place, PlanInput, Venue} from '../src/shared/types.js';
import {loadConfig} from '../src/server/config.js';
import {FINE_DINING_TAGS} from '../src/server/providers/dining-evidence.js';
import {finalizePlan} from '../src/server/services/finalize-plan.js';
import {checkPlan} from '../src/server/services/planner.js';

// Metadata may reveal a different kind of visit after initial scheduling.
test('final acceptance rechecks preference membership after enrichment instead of trusting stale matching IDs', async () => {
  const venue: Venue = {id: 'concert', name: 'Concert', city: 'New York', address: '', coordinates: {latitude: 40.75, longitude: -73.99}, website: '', timezone: 'America/New_York'};
  const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-21', showTime: '17:30', durationMinutes: 180, startingPoint: 'venue'};
  const places: Place[] = ['88888888-8888-8888-8888-888888888881', '88888888-8888-8888-8888-888888888882'].map((id, index) => ({id, name: index ? 'Market Counter' : 'Local Bistro', category: 'food', address: '', coordinates: venue.coordinates, description: 'A neighborhood food stop.', durationMinutes: 35, costTier: 1}));
  const preferences = {minimumStopCount: 1, maximumStopCount: 1, requiredPlaceGroups: [{ids: [places[0]!.id], minimum: 1}]};
  const scheduled = await checkPlan({ids: [places[0]!.id], input, venue, candidates: places, preferences, mode: 'live'});
  assert.ok(scheduled.itinerary);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({results: [{entity_id: places[0]!.id, name: places[0]!.name, subtype: 'urn:entity:place', tags: [{id: FINE_DINING_TAGS[0]}], properties: {}}]}), {status: 200, headers: {'Content-Type': 'application/json'}});
  const config = loadConfig({APP_MODE: 'live', QLOO_API_URL: 'https://api.qloo.com', QLOO_API_KEY: 'finalize-boundary-test-only', OPENAI_API_KEY: 'unused'});
  try {
    const result = await finalizePlan({config, checked: scheduled.itinerary, input, venue, candidates: places, preferences, routeCache: new Map(),
      resolvePreferences: latest => ({...preferences, requiredPlaceGroups: [{ids: latest.filter(place => !place.diningEvidence?.fineDining).map(place => place.id), minimum: 1}]}),
    });
    assert.ok(result.itinerary);
    assert.equal(result.itinerary.stops[0]!.id, places[1]!.id, 'A newly discovered long fine-dining visit cannot satisfy the quick casual-food preference');
    assert.equal(result.candidates.find(place => place.id === places[0]!.id)?.durationMinutes, 90);
    assert.deepEqual(result.itinerary.input, input);
  } finally {globalThis.fetch = originalFetch;}
});
