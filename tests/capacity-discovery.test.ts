import assert from 'node:assert/strict';
import test from 'node:test';
import type {PlanInput, Venue} from '../src/shared/types.js';
import {capacitySearchQueries} from '../src/server/services/capacity-discovery.js';
import {defaultVisitMinutes, FINE_DINING_MINUTES} from '../src/server/services/visit-duration.js';
const venue: Venue = {id: 'concert', name: 'Concert', city: 'New York', address: '', coordinates: {latitude: 40.7505, longitude: -73.9934}, website: '', timezone: 'America/New_York'};
const start = {name: 'SoHo', address: 'SoHo, New York', coordinates: {latitude: 40.7235, longitude: -74.0009}};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-21', showTime: '17:30', durationMinutes: 180, startingPoint: 'around soho'};
test('broad count discovery seeks shorter real stop types without rewriting visit allowances or hard inputs', () => {
  const snapshot = structuredClone(input);
  assert.deepEqual(capacitySearchQueries({input, venue, startingLocation: start, minimumCount: 3, candidates: []}), ['bookstore', 'park']);
  assert.deepEqual(input, snapshot);
  assert.equal(defaultVisitMinutes('food', true), FINE_DINING_MINUTES);
  assert.ok(defaultVisitMinutes('shop') < defaultVisitMinutes('culture'));
  assert.deepEqual(capacitySearchQueries({input, venue, minimumCount: 1, candidates: []}), []);
  assert.deepEqual(capacitySearchQueries({input: {...input, durationMinutes: 30}, venue, startingLocation: start, minimumCount: 3, candidates: []}), [], 'The supplied duration and travel can leave no room for default short visits');
});
