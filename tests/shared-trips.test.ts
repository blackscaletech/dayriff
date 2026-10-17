import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createHttpServer} from '../src/server/app.js';
import {registerSecurity} from '../src/server/security.js';
import {createSessions} from '../src/server/sessions.js';
import {registerSharedRoutes} from '../src/server/shared-routes.js';
import {createMemoryStateStore, type StateStore} from '../src/server/storage/index.js';
import {createFileStateStore} from '../src/server/storage/file-store.js';
import {createSharedTrips, MAX_ACTIVE_SHARES, publicTrip} from '../src/server/services/shared-trips.js';
import {sampleArtists, samplePlaces, sampleVenues} from '../src/server/data/catalog.js';
import {checkPlan} from '../src/server/services/planner.js';
import type {Itinerary} from '../src/shared/types.js';
import type {SessionState} from '../src/server/routes.js';
import type {ServerConfig} from '../src/server/config.js';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';

const config: ServerConfig = {mode: 'sample', port: 3000, host: '127.0.0.1', production: false,
  qlooApiUrl: 'https://hackathon.api.qloo.com', openaiModel: 'test', openaiReasoningEffort: 'medium',
  cookieSecret: 'test-only-share-signing-secret-32-chars', appOrigin: 'http://localhost:3000', maxDailyPlans: 100, maxDailyLookups: 10};
const headers = {'x-dayriff-request': '1', origin: config.appOrigin!};
const secretStart = 'Private hotel room 418, 999 Secret Street';
async function fixture(): Promise<Itinerary> {
  const venue = sampleVenues[0]!;
  const candidates = samplePlaces.filter(place => place.category !== 'food').slice(0, 2);
  const checked = await checkPlan({ids: candidates.map(place => place.id), input: {artist: sampleArtists[0]!, venueId: venue.id,
    date: '2026-10-22', showTime: '19:00', durationMinutes: 480, startingPoint: secretStart, budget: 'high', arrivalBy: '18:15'},
    venue, candidates, mode: 'sample', startingLocation: {name: secretStart, address: '999 Secret Street', coordinates: venue.coordinates}});
  assert.ok(checked.itinerary);
  const plan = checked.itinerary;
  plan.stops.forEach(stop => {stop.reason = `My private preference ${secretStart}`; stop.matchReason = secretStart; stop.localNote = secretStart; stop.photoPrompt = secretStart;});
  plan.notices.push(secretStart);
  return plan;
}
function state(itinerary: Itinerary): SessionState {return {itinerary, messages: [{role: 'user', text: 'Private conversation'}], artists: [], venues: [], cities: [], excludedIds: [], history: []};}
function cookie(header: string | string[] | undefined): string {assert.equal(typeof header, 'string'); return (header as string).split(';')[0]!;}
async function testApp(store = createMemoryStateStore()) {
  const app = createHttpServer(config);
  await registerSecurity(app, config, false, store);
  const sessions = createSessions(config, store);
  const plan = await fixture();
  app.post('/test/prepare', async (request, reply) => {await sessions.mutate(request, reply, async draft => Object.assign(draft, state(plan))); return {id: plan.id};});
  app.post('/test/advance', async (request, reply) => {await sessions.mutate(request, reply, async draft => {draft.itinerary!.revision++; draft.itinerary!.stops[0]!.name = 'Newer unseen version';}); return {ok: true};});
  app.delete('/api/session', async (request, reply) => {await sessions.clear(request, reply); return {cleared: true};});
  await registerSharedRoutes(app, sessions, store);
  app.get('/shared/:token', () => 'Shared app shell');
  return {app, plan};
}

test('public snapshots whitelist trip facts and rebuild all maps without the private first leg', async () => {
  const plan = await fixture(), first = plan.stops[0]!, token = randomBytes(32).toString('base64url');
  const snapshot = publicTrip(plan, token);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [secretStart, '999 Secret Street', 'Private conversation', 'My private preference', 'photoPrompt', 'matchReason', 'localNote', 'budget', 'arrivalBy']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.equal(snapshot.id, token); assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.input.startingPoint, first.name);
  assert.deepEqual(snapshot.startingLocation?.coordinates, first.coordinates);
  assert.equal(snapshot.stops[0]!.walkMinutes, 0); assert.equal(snapshot.stops[0]!.directionsUrl, undefined);
  assert.equal(snapshot.totalWalkMinutes, plan.totalWalkMinutes - first.walkMinutes);
  assert.equal(snapshot.totalMinutes, plan.totalMinutes - first.walkMinutes);
  assert.equal(snapshot.input.durationMinutes, snapshot.totalMinutes, 'Private requested exploration time is not shared');
  assert.equal(snapshot.stops[0]!.arrivalTime, first.arrivalTime);
  assert.equal(snapshot.estimatedArrival, plan.estimatedArrival);
  const route = new URL(snapshot.routeUrl);
  assert.match(route.searchParams.get('origin')!, new RegExp(first.name));
  assert.ok(route.searchParams.get('waypoints')?.includes(String(plan.stops[1]!.coordinates.latitude)));
  assert.match(new URL(snapshot.stops[1]!.directionsUrl!).searchParams.get('origin')!, new RegExp(first.name));
  assert.equal(plan.stops[0]!.walkMinutes, first.walkMinutes, 'Preparing a snapshot never edits the private trip');
  const oversized = structuredClone(plan);
  oversized.venue.address = 'A very long public address '.repeat(100);
  oversized.stops.forEach(stop => {stop.address = 'Another long address '.repeat(100);});
  assert.ok(publicTrip(oversized, token).routeUrl.length <= 2_048, 'Long public addresses cannot truncate Maps waypoints');
});

test('sharing requires owned trip and mutation protection, exposes a public immutable read and clears immediately', async t => {
  const provider = t.mock.method(globalThis, 'fetch', async () => {throw new Error('Sharing must not call a paid provider');});
  const {app, plan} = await testApp();
  try {
    const prepared = await app.inject({method: 'POST', url: '/test/prepare'}), owner = cookie(prepared.headers['set-cookie']);
    const path = `/api/plans/${plan.id}/share`;
    assert.equal((await app.inject({method: 'POST', url: path, payload: {revision: plan.revision}, headers: {cookie: owner}})).statusCode, 403);
    assert.equal((await app.inject({method: 'POST', url: path, payload: {revision: plan.revision}, headers: {...headers, origin: 'https://other.example', cookie: owner}})).statusCode, 403);
    assert.equal((await app.inject({method: 'POST', url: path, payload: {revision: plan.revision}, headers})).statusCode, 404, 'An unrelated browser cannot share a known private plan ID');
    const link = await app.inject({method: 'POST', url: path, payload: {revision: plan.revision}, headers: {...headers, cookie: owner}});
    assert.equal(link.statusCode, 200); assert.match(link.json().shareId, /^[A-Za-z0-9_-]{43}$/);
    const repeated = await app.inject({method: 'POST', url: path, payload: {revision: plan.revision}, headers: {...headers, cookie: owner}});
    assert.deepEqual(repeated.json(), link.json(), 'Repeated preparation reuses the same revision token and expiry');
    const shell = await app.inject(link.json().path);
    assert.equal(shell.headers['cache-control'], 'no-store'); assert.equal(shell.headers['referrer-policy'], 'no-referrer');
    assert.match(String(shell.headers['x-robots-tag']), /noindex/);
    const url = `/api/shared/${link.json().shareId}`;
    const shared = await app.inject(url);
    assert.equal(shared.statusCode, 200); assert.equal(shared.headers['set-cookie'], undefined, 'Recipients never gain or create an owner session');
    assert.equal(shared.headers['cache-control'], 'no-store'); assert.match(String(shared.headers['x-robots-tag']), /noindex/);
    assert.equal(shared.headers['referrer-policy'], 'no-referrer');
    assert.ok(!shared.body.includes(secretStart)); assert.ok(!shared.body.includes('Private conversation'));
    assert.deepEqual(Object.keys(shared.json()).sort(), ['expiresAt', 'itinerary']);
    assert.equal((await app.inject(`/api/shared/${'a'.repeat(43)}`)).statusCode, 404);
    assert.equal((await app.inject('/api/shared/not-a-token')).statusCode, 404);
    assert.equal((await app.inject({method: 'POST', url: `/api/plans/${link.json().shareId}/revise`, headers})).statusCode, 404, 'A public token grants no mutation rights');
    const cleared = await app.inject({method: 'DELETE', url: '/api/session', headers: {...headers, cookie: owner}});
    assert.equal(cleared.statusCode, 200);
    assert.equal((await app.inject(url)).statusCode, 404, 'Clearing the owner physically deletes every trip snapshot and revokes the link');
    assert.equal(provider.mock.calls.length, 0);
  } finally {await app.close();}
});

test('snapshots expire after seven days without recipient activity extending retention; revision links remain stable', async t => {
  let now = Date.UTC(2026, 9, 16, 18); t.mock.method(Date, 'now', () => now);
  const store = createMemoryStateStore(), sharing = createSharedTrips(store), ownerId = randomBytes(32).toString('base64url');
  const draft = state(await fixture());
  const persist = () => store.transact(`session:${ownerId}`, () => ({record: {value: {state: draft}, expiresAt: now + 30 * 86_400_000}, result: undefined}));
  const first = await sharing.publish(draft, ownerId); await persist();
  const initial = await sharing.read(first.shareId);
  draft.itinerary!.revision++; draft.itinerary!.stops[0]!.name = 'A new version';
  const second = await sharing.publish(draft, ownerId); await persist();
  assert.notEqual(first.shareId, second.shareId);
  assert.deepEqual(await sharing.read(first.shareId), initial, 'Changing the private trip leaves the old public snapshot immutable');
  now += 6 * 86_400_000; assert.deepEqual(await sharing.read(first.shareId), initial);
  now += 86_400_000;
  await assert.rejects(sharing.read(first.shareId), {code: 'SHARE_NOT_FOUND'});
  const fresh = await sharing.publish(draft, ownerId); assert.notEqual(fresh.shareId, second.shareId);
  assert.equal(draft.shares?.length, 1, 'Expired snapshots are pruned on the next share');
});

test('a bounded set of active shares never evicts a promised seven-day link', async () => {
  const store = createMemoryStateStore(), sharing = createSharedTrips(store), ownerId = randomBytes(32).toString('base64url');
  const draft = state(await fixture());
  for (let index = 0; index < MAX_ACTIVE_SHARES; index++) {draft.itinerary!.revision = index; await sharing.publish(draft, ownerId);}
  draft.itinerary!.revision++;
  await assert.rejects(sharing.publish(draft, ownerId), {code: 'SHARE_LIMIT'});
  assert.equal(draft.shares?.length, MAX_ACTIVE_SHARES);
});

test('public links survive app/store restarts while a cleared owner cannot be resurrected by an orphan pointer', async () => {
  const directory = await mkdtemp(resolve('.private/shared-tests-'));
  try {
    const store = await createFileStateStore(directory), sharing = createSharedTrips(store), ownerId = randomBytes(32).toString('base64url');
    const draft = state(await fixture()), link = await sharing.publish(draft, ownerId);
    await store.transact(`session:${ownerId}`, () => ({record: {value: {state: draft}, expiresAt: Date.now() + 30 * 86_400_000}, result: undefined}));
    const reopened = createSharedTrips(await createFileStateStore(directory));
    assert.deepEqual((await reopened.read(link.shareId)).itinerary.stops.map(stop => stop.id), draft.itinerary!.stops.map(stop => stop.id));
    await store.transact(`session:${ownerId}`, () => ({result: undefined}));
    await assert.rejects(reopened.read(link.shareId), {code: 'SHARE_NOT_FOUND'});
    const orphan = await sharing.publish(state(await fixture()), randomBytes(32).toString('base64url'));
    await assert.rejects(reopened.read(orphan.shareId), {code: 'SHARE_NOT_FOUND'});
  } finally {await rm(directory, {recursive: true, force: true});}
});


test('clearing during link preparation prevents a late snapshot commit from restoring deleted data', async () => {
  const inner = createMemoryStateStore();
  let release!: () => void, prepared!: () => void, token = '';
  const gate = new Promise<void>(resolve => {release = resolve;});
  const reached = new Promise<void>(resolve => {prepared = resolve;});
  const store: StateStore = {...inner, async transact(key, update) {
    const result = await inner.transact(key, update);
    if (key.startsWith('share:')) {token = key.slice('share:'.length); prepared(); await gate;}
    return result;
  }};
  const {app, plan} = await testApp(store);
  try {
    const created = await app.inject({method: 'POST', url: '/test/prepare'}), owner = cookie(created.headers['set-cookie']);
    const pending = app.inject({method: 'POST', url: `/api/plans/${plan.id}/share`, payload: {revision: plan.revision}, headers: {...headers, cookie: owner}}).then(response => response);
    await reached;
    const cleared = await app.inject({method: 'DELETE', url: '/api/session', headers: {...headers, cookie: owner}});
    assert.equal(cleared.statusCode, 200);
    release();
    assert.equal((await pending).statusCode, 409);
    assert.equal((await app.inject(`/api/shared/${token}`)).statusCode, 404);
  } finally {release(); await app.close();}
});


test('share requires the exact previewed revision and rejects strict invalid bodies before writing any pointer', async () => {
  const inner = createMemoryStateStore(), writes: string[] = [];
  const store: StateStore = {...inner, async transact(key, update) {if (key.startsWith('share:')) writes.push(key); return inner.transact(key, update);}};
  const {app, plan} = await testApp(store);
  try {
    const prepared = await app.inject({method: 'POST', url: '/test/prepare'}), owner = cookie(prepared.headers['set-cookie']);
    const request = {method: 'POST' as const, url: `/api/plans/${plan.id}/share`, headers: {...headers, cookie: owner}};
    for (const payload of [undefined, {}, {revision: -1}, {revision: 0.5}, {revision: '0'}, {revision: 0, unexpected: true}]) {
      const invalid = await app.inject({...request, ...(payload === undefined ? {} : {payload})});
      assert.equal(invalid.statusCode, 400);
    }
    assert.equal((await app.inject({method: 'POST', url: '/test/advance', headers: {cookie: owner}})).statusCode, 200);
    const stale = await app.inject({...request, payload: {revision: plan.revision}});
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'PLAN_CHANGED');
    assert.deepEqual(writes, [], 'A stale preview never publishes unseen places or an orphan pointer');
    const current = await app.inject({...request, payload: {revision: plan.revision + 1}});
    assert.equal(current.statusCode, 200); assert.equal(writes.length, 1);
    const shared = await app.inject(`/api/shared/${current.json().shareId}`);
    assert.equal(shared.json().itinerary.stops[0].name, 'Newer unseen version');
  } finally {await app.close();}
});

test('unknown and invalid shared paths keep private-link indexing and referrer headers on every response', async () => {
  const {app} = await testApp();
  try {
    for (const url of ['/shared', '/shared/', '/shared?unknown=1', '/shared/not-a-token', '/shared/not-a-token/extra', '/api/shared', '/api/shared/', '/api/shared/not-a-token', '/api/shared/not-a-token/extra']) {
      const response = await app.inject(url);
      assert.match(String(response.headers['x-robots-tag']), /noindex/, url);
      assert.equal(response.headers['referrer-policy'], 'no-referrer', url);
      assert.equal(response.headers['cache-control'], 'no-store', url);
    }
  } finally {await app.close();}
});
