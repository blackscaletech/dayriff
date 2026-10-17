import {createTestDirectory} from './helpers/temp-directory.js';
import assert from 'node:assert/strict';
import {rm, readdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import {registerErrorHandler} from '../src/server/app.js';
import type {ServerConfig} from '../src/server/config.js';
import {createSessions} from '../src/server/sessions.js';
import {createFileStateStore} from '../src/server/storage/file-store.js';
import {createStateStore} from '../src/server/storage/index.js';
import {createMemoryStateStore, MAX_RECORD_BYTES, type StateStore} from '../src/server/storage/state-store.js';
import {registerRoutes} from '../src/server/routes.js';
import {sampleArtists, sampleVenues} from '../src/server/data/catalog.js';

const config: ServerConfig = {mode: 'sample', production: false, port: 3000, host: '127.0.0.1', qlooApiUrl: 'https://api.qloo.com',
  openaiModel: 'offline', openaiReasoningEffort: 'medium', cookieSecret: 'offline-durable-cookie-secret-at-least-32', maxDailyPlans: 100, maxDailyLookups: 100};
function sessionCookie(app: string | string[] | undefined): string {
  assert.equal(typeof app, 'string'); return (app as string).split(';')[0]!;
}
async function server(store: StateStore, edit: (message: string) => Promise<void> = async () => {}) {
  const app = Fastify(); await app.register(cookie, {secret: config.cookieSecret}); registerErrorHandler(app);
  const sessions = createSessions(config, store);
  app.get('/trip', async (request, reply) => ({messages: (await sessions(request, reply)).messages}));
  app.post('/trip', async (request, reply) => sessions.mutate(request, reply, async state => {
    const message = (request.body as {message: string}).message; await edit(message); state.messages.push({role: 'user', text: message}); return {messages: state.messages};
  }));
  app.delete('/trip', async (request, reply) => {await sessions.clear(request, reply); return {cleared: true};});
  return app;
}
async function create(app: FastifyInstance, message = 'Saved private trip') {
  const response = await app.inject({method: 'POST', url: '/trip', payload: {message}}); assert.equal(response.statusCode, 200, response.body);
  return sessionCookie(response.headers['set-cookie']);
}

test('local trips survive store/server recreation and records never contain the raw session cookie', async () => {
  const directory = await createTestDirectory('storage-test-'); let app: FastifyInstance | undefined;
  try {
    app = await server(await createFileStateStore(directory)); const cookie = await create(app); await app.close();
    app = await server(await createFileStateStore(directory)); const restored = await app.inject({url: '/trip', headers: {cookie}});
    assert.deepEqual(restored.json().messages, [{role: 'user', text: 'Saved private trip'}]);
    const names = await readdir(directory); assert.equal(names.length, 1); assert.match(names[0]!, /^[a-f0-9]{64}\.json$/);
    assert.equal((await readFile(resolve(directory, names[0]!), 'utf8')).includes(cookie), false);
  } finally {await app?.close(); await rm(directory, {recursive: true, force: true});}
});

test('independent local stores atomically share quota counters without lost updates', async () => {
  const directory = await createTestDirectory('storage-test-');
  try {
    const first = await createFileStateStore(directory), second = await createFileStateStore(directory);
    await Promise.all(Array.from({length: 30}, (_, i) => (i % 2 ? first : second).transact<number, void>('quota', current => ({record: {value: (current ?? 0) + 1, expiresAt: Date.now() + 60000}, result: undefined}))));
    assert.equal(await first.read('quota'), 30);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('a shared session lease prevents duplicate revisions and clear invalidates an in-flight commit', async () => {
  const directory = await createTestDirectory('storage-test-');
  const store = await createFileStateStore(directory), otherStore = await createFileStateStore(directory); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
  const first = await server(store, async message => {if (message === 'Delayed update') {entered(); await gate;}}), second = await server(otherStore);
  let pending: Promise<Awaited<ReturnType<typeof first.inject>>> | undefined;
  try {
    const cookie = await create(first);
    pending = Promise.resolve(first.inject({method: 'POST', url: '/trip', headers: {cookie}, payload: {message: 'Delayed update'}})); await started;
    const blocked = await second.inject({method: 'POST', url: '/trip', headers: {cookie}, payload: {message: 'Conflicting update'}});
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'PLAN_BUSY');
    const clearing = await second.inject({method: 'DELETE', url: '/trip', headers: {cookie}}); assert.equal(clearing.statusCode, 200);
    assert.match(String(clearing.headers['set-cookie']), /Max-Age=0/);
    release(); const stale = await pending; assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'PLAN_CHANGED');
    const empty = await second.inject({url: '/trip', headers: {cookie}}); assert.deepEqual(empty.json().messages, []);
    assert.notEqual(sessionCookie(empty.headers['set-cookie']), cookie, 'A cleared session identity is never reused');
  } finally {release(); if (pending) await pending; await first.close(); await second.close(); await store.close?.(); await otherStore.close?.(); await rm(directory, {recursive: true, force: true});}
});

test('oversize writes and storage outages preserve the last complete saved trip', async () => {
  const store = createMemoryStateStore(), app = await server(store);
  try {
    const cookie = await create(app);
    const large = await app.inject({method: 'POST', url: '/trip', headers: {cookie}, payload: {message: 'x'.repeat(MAX_RECORD_BYTES)}});
    assert.equal(large.statusCode, 413);
    assert.deepEqual((await app.inject({url: '/trip', headers: {cookie}})).json().messages, [{role: 'user', text: 'Saved private trip'}]);
    const outage = await server({read: async () => {throw new Error('offline');}, transact: async () => {throw new Error('offline');}});
    try {assert.equal((await outage.inject({url: '/trip', headers: {cookie}})).statusCode, 500);} finally {await outage.close();}
  } finally {await app.close();}
});

test('production cannot silently choose local or memory storage', async () => {
  await assert.rejects(createStateStore({...config, production: true, storageBackend: 'file'}), /Firestore/);
  await assert.rejects(createStateStore({...config, production: true, storageBackend: 'memory'}), /Firestore/);
});


test('an expired mutation lease can recover after a process dies, and its stale writer cannot overwrite the recovery', async t => {
  const store = createMemoryStateStore(); let now = Date.now(), entered!: () => void, release!: () => void;
  t.mock.method(Date, 'now', () => now);
  const started = new Promise<void>(resolve => {entered = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
  const first = await server(store, async message => {if (message === 'Old process') {entered(); await gate;}}), second = await server(store);
  let pending: Promise<Awaited<ReturnType<typeof first.inject>>> | undefined;
  try {
    const cookie = await create(first);
    pending = Promise.resolve(first.inject({method: 'POST', url: '/trip', headers: {cookie}, payload: {message: 'Old process'}})); await started;
    now += 131000;
    const recovered = await second.inject({method: 'POST', url: '/trip', headers: {cookie}, payload: {message: 'Recovered update'}});
    assert.equal(recovered.statusCode, 200, recovered.body);
    release(); const stale = await pending; assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'PLAN_CHANGED');
    const restored = await second.inject({url: '/trip', headers: {cookie}});
    assert.deepEqual(restored.json().messages.map((item: {text: string}) => item.text), ['Saved private trip', 'Recovered update']);
  } finally {release(); if (pending) await pending; await first.close(); await second.close();}
});

test('real trip routes durably retain revisions, undo history and conversation, then clear all private data', async () => {
  const directory = await createTestDirectory('storage-test-'); let app: FastifyInstance | undefined, store: StateStore | undefined;
  async function start() {
    const next = Fastify(); registerErrorHandler(next); await next.register(cookie, {secret: config.cookieSecret});
    store = await createFileStateStore(directory); const sessions = createSessions(config, store);
    await registerRoutes(next, {config, getSession: sessions, sessions}); return next;
  }
  try {
    app = await start();
    const created = await app.inject({method: 'POST', url: '/api/plans', payload: {artist: sampleArtists[0], venueId: sampleVenues[0]!.id, date: '2026-10-21', showTime: '17:30', durationMinutes: 180, startingPoint: 'Near the venue'}});
    assert.equal(created.statusCode, 200, created.body); const cookie = sessionCookie(created.headers['set-cookie']), original = created.json().itinerary;
    const revised = await app.inject({method: 'POST', url: `/api/plans/${original.id}/revise`, headers: {cookie}, payload: {message: 'Replace this stop with another place.', replaceStopId: original.stops[0].id}});
    assert.equal(revised.statusCode, 200, revised.body); assert.equal(revised.json().history.length, 1);
    const before = (await app.inject({url: '/api/session', headers: {cookie}})).json();
    await app.close(); await store?.close?.(); app = await start();
    const after = (await app.inject({url: '/api/session', headers: {cookie}})).json(); assert.deepEqual(after, before);
    const restored = await app.inject({method: 'POST', url: `/api/plans/${original.id}/restore`, headers: {cookie}, payload: {versionId: after.history[0].id}});
    assert.equal(restored.statusCode, 200, restored.body); assert.deepEqual(restored.json().itinerary.stops.map((item: {id: string}) => item.id), original.stops.map((item: {id: string}) => item.id));
    const cleared = await app.inject({method: 'DELETE', url: '/api/session', headers: {cookie}}); assert.equal(cleared.statusCode, 200);
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 0, 'Clearing removes candidates, preferences, conversation, history and the active plan record');
    assert.deepEqual((await app.inject({url: '/api/session', headers: {cookie}})).json(), {itinerary: null, messages: [], history: []});
  } finally {await app?.close(); await store?.close?.(); await rm(directory, {recursive: true, force: true});}
});


test('malformed local envelopes fail closed without resetting or deleting the existing record', async () => {
  const directory = await createTestDirectory('storage-test-'); const store = await createFileStateStore(directory);
  try {
    await store.transact('session', () => ({record: {value: {private: 'saved'}, expiresAt: Date.now() + 60000}, result: undefined}));
    const path = resolve(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
    for (const malformed of ['{}', '{"value":3}', '{"value":3,"expiresAt":"tomorrow"}', '{"expiresAt":9000000000000}', '{"value":3,"expiresAt":1e999}', 'null']) {
      await writeFile(path, malformed);
      await assert.rejects(store.read('session'), (error: unknown) => (error as {code: string}).code === 'STORAGE_UNAVAILABLE');
      let updated = false;
      await assert.rejects(store.transact('session', () => {updated = true; return {record: {value: 'replacement', expiresAt: Date.now() + 60000}, result: undefined};}), (error: unknown) => (error as {code: string}).code === 'STORAGE_UNAVAILABLE');
      assert.equal(updated, false, 'A malformed envelope must not be supplied to the updater as missing');
      assert.equal(await readFile(path, 'utf8'), malformed, 'The unreadable private record is preserved for recovery');
    }
  } finally {await store.close?.(); await rm(directory, {recursive: true, force: true});}
});
