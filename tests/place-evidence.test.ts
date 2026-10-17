import assert from 'node:assert/strict';
import test from 'node:test';
import {discoverPlaces} from '../src/server/providers/qloo.js';
import {checkPlan} from '../src/server/services/planner.js';
import type {PlanInput, Venue} from '../src/shared/types.js';

const venue: Venue = {id: '30000000-0000-4000-8000-000000000000', name: 'The Concert Hall', city: 'New York',
  address: '', coordinates: {latitude: 40.72, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: '30000000-0000-4000-8000-000000000001', name: 'The Rolling Stones'},
  venueId: venue.id, date: '2026-10-30', showTime: '19:00', durationMinutes: 180, startingPoint: ''};

test('taste provenance preserves real Qloo evidence without manufacturing repeated cultural explanations', async () => {
  const original = globalThis.fetch;
  const descriptions = [
    'A neighborhood record shop specializing in jazz, soul and funk vinyl, with a collection of local music zines.',
    'An art gallery showing contemporary photography and sculpture by regional artists in a converted warehouse.',
  ];
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    assert.equal(url.hostname, 'api.qloo.com');
    assert.equal(url.pathname, '/v2/insights');
    assert.equal(url.searchParams.get('signal.interests.entities'), input.artist.id);
    return new Response(JSON.stringify({results: {entities: descriptions.map((description, index) => ({
      entity_id: `30000000-0000-4000-8000-00000000000${index + 2}`, name: ['Neighborhood Records', 'Warehouse Gallery'][index],
      subtype: 'urn:entity:place', location: {lat: 40.7201 + index * .0001, lon: -73.9901}, query: {affinity: [.83, .71][index]},
      tags: [{id: `urn:tag:genre:place:${index ? 'art_gallery' : 'record_store'}`}], properties: {description},
    }))}}), {status: 200, headers: {'Content-Type': 'application/json'}});
  };
  try {
    const places = await discoverPlaces({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'place-evidence-test-only'}, input.artist, venue);
    assert.equal(places.length, 2);
    for (const place of places) {
      assert.deepEqual(place.recommendation, {source: 'qloo_taste'});
      assert.ok(typeof place.affinity === 'number');
      assert.equal(place.matchReason, undefined, 'Retrieval rank cannot be rewritten as a cultural explanation');
      assert.ok(descriptions.includes(place.description), 'Each description remains the actual place-specific fact');
    }
    const result = await checkPlan({ids: places.map(place => place.id), input, venue, candidates: places, mode: 'live'});
    assert.ok(result.itinerary);
    assert.ok(result.itinerary.stops.every(stop => stop.reason === undefined && stop.matchReason === undefined));
    assert.equal(new Set(result.itinerary.stops.map(stop => stop.description)).size, 2);
  } finally {globalThis.fetch = original;}
});
