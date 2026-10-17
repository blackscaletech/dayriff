import {createHash} from 'node:crypto';
import {Firestore, Timestamp} from '@google-cloud/firestore';
import {ServiceError} from '../errors.js';
import {clone, encodeRecord, storageUnavailable, type StateStore, type StoreChange, type StoredValue} from './state-store.js';

export function createFirestoreStateStore(projectId?: string, databaseId = '(default)', client?: Firestore): StateStore {
  const db = client ?? new Firestore({projectId, databaseId, preferRest: true, ignoreUndefinedProperties: true});
  const reference = (key: string) => db.collection('dayriff_state').doc(createHash('sha256').update(key).digest('hex'));
  function decode<T>(data: FirebaseFirestore.DocumentData | undefined): T | undefined {
    if (data === undefined) return undefined;
    if (!data || !(data.expiresAt instanceof Timestamp) || !Number.isFinite(data.expiresAt.toMillis()) || typeof data.payload !== 'string') throw storageUnavailable();
    // Validate the payload even when expired: malformed existing records never become missing counters/trips.
    const value = JSON.parse(data.payload) as T;
    return data.expiresAt.toMillis() <= Date.now() ? undefined : value;
  }
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {return decode<T>((await reference(key).get()).data());} catch {throw storageUnavailable();}
    },
    async transact<T, R>(key: string, update: (current: T | undefined) => StoreChange<T, R>): Promise<R> {
      try {
        return await db.runTransaction(async transaction => {
          const ref = reference(key), snapshot = await transaction.get(ref), current = decode<T>(snapshot.data());
          const change = update(current === undefined ? undefined : clone(current));
          if (change.unchanged) return change.result;
          if (change.record) {
            encodeRecord(change.record);
            transaction.set(ref, {payload: JSON.stringify(change.record.value), expiresAt: Timestamp.fromMillis(change.record.expiresAt)});
          } else if (snapshot.exists) transaction.delete(ref);
          return change.result;
        }, {maxAttempts: 3});
      } catch (error) {if (error instanceof ServiceError) throw error; throw storageUnavailable();}
    },
    async close() {await db.terminate();},
  };
}
