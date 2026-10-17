import assert from 'node:assert/strict';
import test from 'node:test';
import {Firestore, Timestamp} from '@google-cloud/firestore';
import {createFirestoreStateStore} from '../src/server/storage/firestore-store.js';
import {MAX_RECORD_BYTES} from '../src/server/storage/state-store.js';
import {ServiceError} from '../src/server/errors.js';

/** Contract fake only: exercises adapter serialization/transaction boundaries, not Google infrastructure. */
function fakeDatabase() {
  const records = new Map<string, {payload: string; expiresAt: Timestamp}>();
  let offline = false, retry = false, calls = 0, writes = 0;
  const reference = (id: string) => ({id, async get() {if (offline) throw new Error('unavailable'); return {exists: records.has(id), data: () => records.get(id)};}});
  const fake = {
    collection(name: string) {assert.equal(name, 'dayriff_state'); return {doc: reference};},
    async runTransaction<T>(task: (transaction: unknown) => Promise<T>) {
      if (offline) throw new Error('unavailable');
      let result!: T;
      const attempts = retry ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const mutations: (() => void)[] = [];
        calls++;
        result = await task({get: (ref: ReturnType<typeof reference>) => ref.get(),
          set: (ref: ReturnType<typeof reference>, value: {payload: string; expiresAt: Timestamp}) => mutations.push(() => {writes++; records.set(ref.id, value);}),
          delete: (ref: ReturnType<typeof reference>) => mutations.push(() => {writes++; records.delete(ref.id);})});
        if (attempt === attempts - 1) for (const mutate of mutations) mutate();
      }
      return result;
    },
    async terminate() {},
  };
  return {store: createFirestoreStateStore('offline-project', '(default)', fake as unknown as Firestore), records,
    offline() {offline = true;}, retry() {retry = true;}, stats: () => ({calls, writes})};
}

test('Firestore adapter uses server-only JSON payloads, hashed IDs, expiry timestamps and retry-safe updates', async () => {
  const fake = fakeDatabase(), expiry = Date.now() + 60000;
  await fake.store.transact('session:private-cookie', () => ({record: {value: {nested: [[1, 2]], omitted: undefined}, expiresAt: expiry}, result: true}));
  const [[id, raw]] = [...fake.records.entries()]; assert.match(id!, /^[a-f0-9]{64}$/); assert.ok(raw!.expiresAt instanceof Timestamp); assert.equal(raw!.expiresAt.toMillis(), expiry);
  assert.deepEqual(await fake.store.read('session:private-cookie'), {nested: [[1, 2]]});
  fake.retry(); await fake.store.transact<{nested: number[][]}, void>('session:private-cookie', current => ({record: {value: {nested: [...current!.nested, [3]]}, expiresAt: expiry}, result: undefined}));
  assert.deepEqual(await fake.store.read('session:private-cookie'), {nested: [[1, 2], [3]]}, 'An SDK transaction retry applies the pure state change only once');
  assert.equal(fake.stats().calls, 3);
  const before = fake.stats().writes; await fake.store.transact('session:private-cookie', () => ({unchanged: true, result: false})); assert.equal(fake.stats().writes, before);
});

test('expired Firestore records cannot be read and oversize or failed writes leave the previous value intact', async () => {
  const fake = fakeDatabase();
  await fake.store.transact('session', () => ({record: {value: 'safe', expiresAt: Date.now() + 60000}, result: undefined}));
  await assert.rejects(fake.store.transact('session', () => ({record: {value: 'x'.repeat(MAX_RECORD_BYTES), expiresAt: Date.now() + 60000}, result: undefined})), (error: unknown) => error instanceof ServiceError && error.code === 'STORAGE_LIMIT');
  assert.equal(await fake.store.read('session'), 'safe');
  const [[, raw]] = [...fake.records.entries()]; raw!.expiresAt = Timestamp.fromMillis(Date.now() - 1);
  assert.equal(await fake.store.read('session'), undefined);
  await fake.store.transact('session', current => {assert.equal(current, undefined); return {result: undefined};}); assert.equal(fake.records.size, 0);
  fake.offline();
  for (const task of [fake.store.read('session'), fake.store.transact('session', () => ({result: undefined}))]) await assert.rejects(task, (error: unknown) => error instanceof ServiceError && error.statusCode === 503 && error.code === 'STORAGE_UNAVAILABLE');
});


test('malformed existing Firestore envelopes fail closed rather than resetting counters or private trips', async () => {
  const fake = fakeDatabase();
  await fake.store.transact('session', () => ({record: {value: 'saved', expiresAt: Date.now() + 60000}, result: undefined}));
  const id = [...fake.records.keys()][0]!;
  for (const malformed of [{}, {payload: '"saved"'}, {expiresAt: Timestamp.fromMillis(Date.now() + 60000)},
    {payload: '"saved"', expiresAt: 9000000000000}, {payload: '{broken-json', expiresAt: Timestamp.fromMillis(Date.now() - 1)}]) {
    fake.records.set(id, malformed as {payload: string; expiresAt: Timestamp});
    await assert.rejects(fake.store.read('session'), (error: unknown) => error instanceof ServiceError && error.code === 'STORAGE_UNAVAILABLE');
    let updated = false;
    await assert.rejects(fake.store.transact('session', () => {updated = true; return {record: {value: 'replacement', expiresAt: Date.now() + 60000}, result: undefined};}),
      (error: unknown) => error instanceof ServiceError && error.code === 'STORAGE_UNAVAILABLE');
    assert.equal(updated, false); assert.equal(fake.records.get(id), malformed);
  }
});
