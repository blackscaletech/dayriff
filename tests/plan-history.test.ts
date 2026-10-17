import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import {registerRoutes, type SessionState} from '../src/server/routes.js';
import {registerErrorHandler} from '../src/server/app.js';
import {loadConfig} from '../src/server/config.js';
import {sampleArtists, sampleVenues} from '../src/server/data/catalog.js';
import {capturePlan, planHistory} from '../src/server/services/plan-history.js';

function session(): SessionState {return {artists: [], venues: [], cities: [], excludedIds: [], history: [], messages: []};}
test('earlier plans restore only from trusted session snapshots and retain shown-place memory', async () => {
  const first = session(), second = session(), app = Fastify();
  registerErrorHandler(app);
  await registerRoutes(app, {config: loadConfig({APP_MODE: 'sample'}), getSession: request => request.headers['x-test-session'] === 'second' ? second : first});
  try {
    const created = await app.inject({method: 'POST', url: '/api/plans', payload: {artist: sampleArtists[0], venueId: sampleVenues[0]!.id, date: '2026-10-21', showTime: '17:30', durationMinutes: 180, startingPoint: 'Near the venue'}});
    assert.equal(created.statusCode, 200, created.body);
    const original = created.json().itinerary;
    const revised = await app.inject({method: 'POST', url: `/api/plans/${original.id}/revise`, payload: {message: 'Replace this stop with another place.', replaceStopId: original.stops[0].id}});
    assert.equal(revised.statusCode, 200, revised.body);
    const changed = revised.json();
    assert.equal(changed.itinerary.stops.length, original.stops.length);
    assert.notDeepEqual(changed.itinerary.stops.map((s: {id: string}) => s.id), original.stops.map((s: {id: string}) => s.id));
    assert.equal(changed.history.length, 1);
    assert.deepEqual(changed.history[0].schedule, {date: original.input.date, showTime: original.input.showTime, durationMinutes: original.input.durationMinutes});
    const payload = {versionId: changed.history[0].id};
    assert.equal((await app.inject({method: 'POST', url: `/api/plans/${original.id}/restore`, headers: {'x-test-session': 'second'}, payload})).statusCode, 404);
    assert.equal((await app.inject({method: 'POST', url: `/api/plans/${original.id}/restore`, payload: {...payload, itinerary: original}})).statusCode, 400);
    const restored = await app.inject({method: 'POST', url: `/api/plans/${original.id}/restore`, payload});
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json().itinerary.stops.map((s: {id: string}) => s.id), original.stops.map((s: {id: string}) => s.id));
    assert.ok(restored.json().itinerary.revision > changed.itinerary.revision);
    assert.deepEqual(restored.json().itinerary.input, original.input, 'Restoring a plan restores its show-based schedule and omitted optional inputs');
    assert.deepEqual(first.excludedIds, []);
    const swapped = changed.itinerary.stops.find((s: {id: string}) => !original.stops.some((old: {id: string}) => old.id === s.id));
    assert.ok(first.memory?.shown.some(place => place.id === swapped.id), 'Undo must not forget what was already shown');
    assert.equal(restored.json().history.length, 1, 'The replaced version remains available for redo');
  } finally {await app.close();}
});


test('history removal is session-owned, idempotent, and leaves the current plan and conversation intact', async () => {
  const first = session(), second = session(), app = Fastify();
  registerErrorHandler(app);
  await registerRoutes(app, {config: loadConfig({APP_MODE: 'sample'}), getSession: request => request.headers['x-test-session'] === 'second' ? second : first});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('History removal and restoration boundaries never call a provider');};
  try {
    const created = await app.inject({method: 'POST', url: '/api/plans', payload: {artist: sampleArtists[0], venueId: sampleVenues[0]!.id, date: '2026-10-21', showTime: '17:30', durationMinutes: 180, startingPoint: 'Near the venue'}});
    assert.equal(created.statusCode, 200, created.body);
    const active = first.itinerary!;
    first.excludedIds = ['rejected-place'];
    const kept = capturePlan({...active, revision: 1}, first.memory, first.excludedIds);
    const removed = capturePlan(active, first.memory, []);
    first.history = [kept, removed];
    const baseline = structuredClone(first);
    const url = `/api/plans/${active.id}/history/${removed.id}`;
    const other = structuredClone(second);
    const foreign = await app.inject({method: 'DELETE', url, headers: {'x-test-session': 'second'}});
    assert.equal(foreign.statusCode, 404); assert.equal(foreign.json().code, 'PLAN_NOT_FOUND');
    assert.deepEqual(first, baseline); assert.deepEqual(second, other);
    for (const invalidUrl of [`/api/plans/not-a-uuid/history/${removed.id}`, `/api/plans/${active.id}/history/not-a-uuid`]) {
      assert.equal((await app.inject({method: 'DELETE', url: invalidUrl})).statusCode, 400);
      assert.deepEqual(first, baseline);
    }
    first.busy = true;
    const busy = await app.inject({method: 'DELETE', url});
    assert.equal(busy.statusCode, 409); assert.equal(busy.json().code, 'PLAN_BUSY');
    assert.deepEqual(first.history, baseline.history); assert.equal(first.busy, true);
    first.busy = false;
    const result = await app.inject({method: 'DELETE', url});
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), {history: planHistory([kept])});
    assert.deepEqual(first.history, [kept]); assert.equal(first.history[0], kept);
    assert.equal(first.itinerary, active); assert.deepEqual(first.itinerary, baseline.itinerary);
    assert.deepEqual(first.messages, baseline.messages); assert.deepEqual(first.memory, baseline.memory);
    assert.deepEqual(first.candidates, baseline.candidates); assert.deepEqual(first.excludedIds, baseline.excludedIds);
    assert.deepEqual(second, other);
    const retry = await app.inject({method: 'DELETE', url});
    assert.equal(retry.statusCode, 200); assert.deepEqual(retry.json(), result.json());
    const absent = await app.inject({method: 'DELETE', url: `/api/plans/${active.id}/history/${randomUUID()}`});
    assert.equal(absent.statusCode, 200); assert.deepEqual(absent.json(), result.json());
    const beforeRestore = structuredClone(first);
    const restore = await app.inject({method: 'POST', url: `/api/plans/${active.id}/restore`, payload: {versionId: removed.id}});
    assert.equal(restore.statusCode, 404); assert.equal(restore.json().code, 'VERSION_NOT_FOUND');
    assert.deepEqual(first, beforeRestore);
    const missingPlan = await app.inject({method: 'DELETE', url: `/api/plans/${randomUUID()}/history/${kept.id}`});
    assert.equal(missingPlan.statusCode, 404); assert.deepEqual(first, beforeRestore);
  } finally {globalThis.fetch = originalFetch; await app.close();}
});
