import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import test from 'node:test';
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import {registerErrorHandler} from '../src/server/app.js';
import type {ServerConfig} from '../src/server/config.js';
import {registerRoutes, type SessionState} from '../src/server/routes.js';
import {createSessions} from '../src/server/sessions.js';
import {sampleArtists, samplePlaces, sampleVenues} from '../src/server/data/catalog.js';
import {checkPlan} from '../src/server/services/planner.js';
import {capturePlan} from '../src/server/services/plan-history.js';
import {createRevisionMemory, rememberPlan} from '../src/server/services/revision-memory.js';
import {withPlanDeadline} from '../src/server/services/operation-deadline.js';
import {ServiceError} from '../src/server/errors.js';

const config: ServerConfig = {mode: 'live', port: 3000, host: '127.0.0.1', production: false,
  qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'offline-only', openaiApiKey: 'offline-only',
  openaiModel: 'offline-test', openaiReasoningEffort: 'medium', cookieSecret: 'offline-cookie-signing-secret-for-route-tests',
  maxDailyPlans: 20, maxDailyLookups: 20};
const input = {artist: sampleArtists[0]!, venueId: sampleVenues[0]!.id, date: '2026-10-21', showTime: '19:00', durationMinutes: 360, startingPoint: 'Near the venue'};
function interpreted(kind: 'clarify' | 'answer' | 'adjust' = 'clarify') {
  return new Response(JSON.stringify({output: [{type: 'function_call', name: 'interpret_turn', call_id: 'offline-intent', arguments: JSON.stringify({
    kind, stop_count_operation: 'unchanged', minimum_total_stops: 0, maximum_total_stops: 0,
    replace_stop_id: null, keep_stop_ids: [], place_scope: 'unchanged', place_policy_facts: [], place_requests: [], drop_preferences: [], keep_preferences: [], minimum_changes: 0,
    show_time_update: 'unchanged', duration_update: kind === 'adjust' ? 390 : null, budget_update: 'unchanged', arrival_update: 'unchanged',
    walking: 'unchanged', reject_ids: [], restore_ids: [], clarification: kind === 'clarify' ? 'Choose which existing preference you want to change.' : null,
  })}]}));
}
async function harness() {
  const app = Fastify(), states: SessionState[] = [];
  await app.register(cookie, {secret: config.cookieSecret});
  registerErrorHandler(app);
  const lookup = createSessions(config), owned = new Map<string, SessionState>();
  const checked = await checkPlan({ids: samplePlaces.slice(0, 3).map(place => place.id), input, venue: sampleVenues[0]!, candidates: samplePlaces, mode: 'live'});
  assert.ok(checked.itinerary, checked.issues.join(' '));
  await registerRoutes(app, {config, getSession: async (request, reply) => {
    const identity = await lookup.identity(request, reply);
    const state = owned.get(identity) ?? await lookup(request, reply);
    owned.set(identity, state);
    if (!states.includes(state)) {
      const itinerary = {...structuredClone(checked.itinerary!), id: randomUUID(), revision: 2};
      const memory = rememberPlan(createRevisionMemory(itinerary), itinerary,
        [{query: 'bookstore', minimum: 1, strength: 'required', ids: [itinerary.stops[0]!.id]}], 100, {minimum: 3, maximum: 3});
      Object.assign(state, {itinerary, memory, candidates: structuredClone(samplePlaces), excludedIds: ['sample:rejected'],
        messages: [{role: 'assistant', text: 'Your saved outing.'}], history: [capturePlan({...itinerary, revision: 1}, memory, [])], busy: false});
      states.push(state);
    }
    return state;
  }});
  return {app, states};
}
async function owner(app: FastifyInstance) {
  const response = await app.inject('/api/session');
  assert.equal(response.statusCode, 200);
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return {cookie: (header as string).split(';')[0]!, planId: response.json().itinerary.id as string};
}
function expectProvider(resource: Parameters<typeof fetch>[0]) {
  assert.equal(new URL(String(resource)).hostname, 'api.openai.com', 'Offline tests must never discover or fetch real place data');
}

test('real session cookies reject foreign plan/version operations without changing either saved outing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {throw new Error('Ownership rejection must not call a provider');};
  const {app, states} = await harness();
  try {
    const first = await owner(app), second = await owner(app), snapshots = structuredClone(states);
    const foreignVersion = states[0]!.history[0]!.id;
    for (const request of [
      {method: 'POST' as const, url: `/api/plans/${first.planId}/revise`, payload: {message: 'More culture'}},
      {method: 'POST' as const, url: `/api/plans/${first.planId}/restore`, payload: {versionId: foreignVersion}},
      {method: 'DELETE' as const, url: `/api/plans/${first.planId}/history/${foreignVersion}`},
    ]) {
      const response = await app.inject({...request, headers: {cookie: second.cookie}});
      assert.equal(response.statusCode, 404); assert.equal(response.json().code, 'PLAN_NOT_FOUND');
      assert.deepEqual(states, snapshots);
    }
    const restore = await app.inject({method: 'POST', url: `/api/plans/${second.planId}/restore`, headers: {cookie: second.cookie}, payload: {versionId: foreignVersion}});
    assert.equal(restore.statusCode, 404); assert.equal(restore.json().code, 'VERSION_NOT_FOUND');
    const removal = await app.inject({method: 'DELETE', url: `/api/plans/${second.planId}/history/${foreignVersion}`, headers: {cookie: second.cookie}});
    assert.equal(removal.statusCode, 200, 'Removing an unknown version is idempotent but cannot affect its actual owner');
    assert.deepEqual(states, snapshots);
  } finally {globalThis.fetch = original; await app.close();}
});

test('a pending revision blocks its own session, leaves another usable, and releases its lock after provider failure', {timeout: 5000}, async () => {
  const {app, states} = await harness(), first = await owner(app), second = await owner(app);
  const baseline = structuredClone(states), original = globalThis.fetch;
  let entered!: () => void, release!: () => void, calls = 0;
  const started = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
  globalThis.fetch = async resource => {
    expectProvider(resource); calls++;
    if (calls === 1) {entered(); await gate; throw new ServiceError('Provider temporarily unavailable.', 503, 'PROVIDER_BUSY');}
    return interpreted();
  };
  let pending: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
  try {
    pending = Promise.resolve(app.inject({method: 'POST', url: `/api/plans/${first.planId}/revise`, headers: {cookie: first.cookie}, payload: {message: 'More culture'}}));
    await started;
    const blocked = await app.inject({method: 'POST', url: `/api/plans/${first.planId}/revise`, headers: {cookie: first.cookie}, payload: {message: 'Less walking'}});
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'PLAN_BUSY');
    assert.equal(calls, 1, 'A busy rejection spends no provider call');
    const other = await app.inject({method: 'POST', url: `/api/plans/${second.planId}/revise`, headers: {cookie: second.cookie}, payload: {message: 'Clarify my preference'}});
    assert.equal(other.statusCode, 200); assert.equal(states[1]!.messages.length, baseline[1]!.messages.length + 2);
    const otherAfter = structuredClone(states[1]);
    assert.deepEqual(states[0], {...baseline[0], busy: true});
    release();
    const failed = await pending;
    assert.equal(failed.statusCode, 503); assert.equal(failed.json().code, 'PROVIDER_BUSY');
    assert.deepEqual(states[0], baseline[0], 'Provider failure changes neither plan, memory, candidates, history, exclusions nor conversation');
    assert.deepEqual(states[1], otherAfter, 'The failed request cannot roll back another session');
    const retry = await app.inject({method: 'POST', url: `/api/plans/${first.planId}/revise`, headers: {cookie: first.cookie}, payload: {message: 'Clarify my preference'}});
    assert.equal(retry.statusCode, 200, 'A new turn can proceed after the lock is released');
    assert.deepEqual(states[0]!.itinerary, baseline[0]!.itinerary);
    assert.deepEqual(states[0]!.history, baseline[0]!.history);
    assert.deepEqual(states[0]!.memory, baseline[0]!.memory);
    assert.deepEqual(states[0]!.excludedIds, baseline[0]!.excludedIds);
    assert.deepEqual(states[0]!.candidates, baseline[0]!.candidates);
    assert.equal(states[0]!.messages.length, baseline[0]!.messages.length + 2, 'Only the explicit clarification exchange is added');
  } finally {release(); if (pending) await pending; globalThis.fetch = original; await app.close();}
});

test('a late valid provider answer cannot commit conversation or plan state after the operation deadline', async () => {
  const {app, states} = await harness(), current = await owner(app), baseline = structuredClone(states[0]), original = globalThis.fetch;
  let calls = 0, providerSawAbort = false, response: Awaited<ReturnType<typeof app.inject>> | undefined;
  globalThis.fetch = async (resource, init) => {
    expectProvider(resource); calls++;
    if (calls === 1) return interpreted('answer');
    await pause(160);
    providerSawAbort = Boolean(init?.signal?.aborted);
    return new Response(JSON.stringify({output: [{type: 'function_call', name: 'answer_plan', call_id: 'offline-answer', arguments: JSON.stringify({answer: 'A late but valid explanation.'})}]}));
  };
  try {
    await assert.rejects(withPlanDeadline(async () => {
      response = await app.inject({method: 'POST', url: `/api/plans/${current.planId}/revise`, headers: {cookie: current.cookie}, payload: {message: 'Why these places?'}});
    }, 100), (error: unknown) => error instanceof ServiceError && error.code === 'PLAN_TIMEOUT');
    assert.equal(calls, 2); assert.equal(providerSawAbort, true);
    assert.equal(response?.statusCode, 504); assert.equal(response?.json().code, 'PLAN_TIMEOUT');
    assert.deepEqual(states[0], baseline, 'A timed-out answer cannot partially append messages or alter any saved state');
    const restored = await app.inject({url: '/api/session', headers: {cookie: current.cookie}});
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.json().itinerary, baseline!.itinerary);
    assert.deepEqual(restored.json().messages, baseline!.messages);
    assert.equal(states[0]!.busy, false, 'A timeout releases the per-session mutation lock');
  } finally {globalThis.fetch = original; await app.close();}
});


test('a valid timing update arriving after the deadline cannot change the plan or undo history, and a fresh retry can succeed', async () => {
  const {app, states} = await harness(), current = await owner(app), baseline = structuredClone(states[0]), original = globalThis.fetch;
  let calls = 0, response: Awaited<ReturnType<typeof app.inject>> | undefined;
  globalThis.fetch = async resource => {expectProvider(resource); calls++; await pause(160); return interpreted('adjust');};
  try {
    await assert.rejects(withPlanDeadline(async () => {
      response = await app.inject({method: 'POST', url: `/api/plans/${current.planId}/revise`, headers: {cookie: current.cookie}, payload: {message: 'Allow 30 more minutes to explore.'}});
    }, 100), (error: unknown) => error instanceof ServiceError && error.code === 'PLAN_TIMEOUT');
    assert.equal(calls, 1); assert.equal(response?.statusCode, 504); assert.equal(response?.json().code, 'PLAN_TIMEOUT');
    assert.deepEqual(states[0], baseline, 'A late, otherwise valid mutation must not alter saved state or create an undo version');
    globalThis.fetch = async resource => {expectProvider(resource); return interpreted('adjust');};
    const retry = await app.inject({method: 'POST', url: `/api/plans/${current.planId}/revise`, headers: {cookie: current.cookie}, payload: {message: 'Allow 30 more minutes to explore.'}});
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().itinerary.input.durationMinutes, 390, 'The same authorized change is valid when it completes within its new deadline');
    assert.equal(states[0]!.history.length, baseline!.history.length + 1, 'Only the successful retry creates an undo version');
    assert.deepEqual(states[0]!.excludedIds, baseline!.excludedIds);
  } finally {globalThis.fetch = original; await app.close();}
});
