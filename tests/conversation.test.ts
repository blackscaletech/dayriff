import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { CHAT_HISTORY_LIMIT } from '../src/shared/chat.js';
import type { ChatMessage } from '../src/shared/types.js';
import { registerErrorHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { sampleArtists, sampleVenues } from '../src/server/data/catalog.js';
import { registerRoutes, type SessionState } from '../src/server/routes.js';

test('successful revisions retain bounded conversation and session reload returns the same history', async () => {
  const session: SessionState = {artists: [], venues: [], cities: [], excludedIds: [], history: [], messages: []};
  const app = Fastify();
  registerErrorHandler(app);
  await registerRoutes(app, {config: loadConfig({APP_MODE: 'sample'}), getSession: () => session});
  const details = {artist: sampleArtists[0], venueId: sampleVenues[0]!.id, date: '2026-10-21', showTime: '17:30', durationMinutes: 180, startingPoint: 'Near the venue'};
  try {
    const created = await app.inject({method: 'POST', url: '/api/plans', payload: details});
    assert.equal(created.statusCode, 200, created.body);
    const previous = created.json().itinerary;
    const earlier: ChatMessage[] = Array.from({length: CHAT_HISTORY_LIMIT - 1}, (_, index) => ({role: index % 2 ? 'user' : 'assistant', text: `Earlier message ${index}`}));
    session.messages = [...earlier];
    const message = 'Replace this stop with another place.';
    const revised = await app.inject({method: 'POST', url: `/api/plans/${previous.id}/revise`, payload: {message, replaceStopId: previous.stops[0].id}});
    assert.equal(revised.statusCode, 200, revised.body);
    const result = revised.json();
    assert.notDeepEqual(result.itinerary.stops.map((stop: {id: string}) => stop.id), previous.stops.map((stop: {id: string}) => stop.id), 'The request must complete a real revision');
    assert.equal(session.messages.length, CHAT_HISTORY_LIMIT);
    const expected: ChatMessage[] = [...earlier.slice(1), {role: 'user', text: message}, {role: 'assistant', text: result.message}];
    assert.deepEqual(session.messages, expected, 'Only the oldest message is pruned; prior turns and the new exchange remain');
    const restored = await app.inject({method: 'GET', url: '/api/session'});
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().messages, expected);
    assert.equal(restored.json().itinerary.revision, result.itinerary.revision);
    const newPlan = await app.inject({method: 'POST', url: '/api/plans', payload: details});
    assert.equal(newPlan.statusCode, 200, newPlan.body);
    assert.deepEqual(session.messages, [{role: 'assistant', text: newPlan.json().message}], 'Creating another outing starts a fresh conversation');
  } finally { await app.close(); }
});
