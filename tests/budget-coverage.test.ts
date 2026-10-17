import assert from 'node:assert/strict';
import test from 'node:test';
import type {Place, PlanInput, Venue} from '../src/shared/types.js';
import {refinementLimit} from '../src/server/services/revisions.js';

const venue: Venue = {id: 'venue', name: 'Concert', city: 'New York', address: '', website: '', timezone: 'America/New_York', coordinates: {latitude: 40.75, longitude: -73.99}};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-22', showTime: '19:00', durationMinutes: 360, startingPoint: 'SoHo', budget: 'low'};
const gallery: Place = {id: 'gallery', name: 'Local Gallery', category: 'culture', coordinates: venue.coordinates, address: '', description: 'An art gallery.', durationMinutes: 35};

test('missing cultural prices explain the verified-budget barrier without inventing free admission', () => {
  const groups = [{query: 'culture', ids: [gallery.id], minimum: 1, turnSearch: true}];
  const unknown = refinementLimit(groups, input, venue, undefined, undefined, [gallery]);
  assert.match(unknown, /verified price tier within your low budget/);
  assert.match(unknown, /remove the budget preference/);
  assert.doesNotMatch(unknown, /could not fit 3 stops|free admission/);
  const known = refinementLimit(groups, input, venue, undefined, undefined, [{...gallery, costTier: 1}]);
  assert.doesNotMatch(known, /none has a verified price tier/);
});
