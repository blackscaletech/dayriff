import {ServiceError} from '../errors.js';

export interface StoredValue<T> {value: T; expiresAt: number}
export interface StoreChange<T, R> {record?: StoredValue<T>; unchanged?: boolean; result: R}
/** Updaters must be synchronous and side-effect free: a durable backend may retry them. */
export interface StateStore {
  transact<T, R>(key: string, update: (current: T | undefined) => StoreChange<T, R>): Promise<R>;
  read<T>(key: string): Promise<T | undefined>;
  close?(): Promise<void>;
}
export const MAX_RECORD_BYTES = 850_000;
export function validateRecord<T>(record: unknown): StoredValue<T> {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.hasOwn(record, 'value') ||
      (record as StoredValue<unknown>).value === undefined || typeof (record as StoredValue<unknown>).expiresAt !== 'number' ||
      !Number.isFinite((record as StoredValue<unknown>).expiresAt)) throw storageUnavailable();
  return record as StoredValue<T>;
}
export function encodeRecord<T>(record: StoredValue<T>): string {
  validateRecord(record);
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > MAX_RECORD_BYTES) throw new ServiceError('This saved trip is too large. Start a new trip to continue.', 413, 'STORAGE_LIMIT');
  return json;
}
export function storageUnavailable(): ServiceError {
  return new ServiceError('Your saved trip is temporarily unavailable. Please try again shortly.', 503, 'STORAGE_UNAVAILABLE');
}
export function clone<T>(value: T): T {return JSON.parse(JSON.stringify(value)) as T;}
export function createMemoryStateStore(): StateStore {
  const records = new Map<string, StoredValue<unknown>>();
  return {
    async transact<T, R>(key: string, update: (current: T | undefined) => StoreChange<T, R>): Promise<R> {
      const saved = records.get(key), current = saved && saved.expiresAt > Date.now() ? clone(saved.value) as T : undefined;
      const change = update(current);
      if (!change.unchanged) {if (change.record) {encodeRecord(change.record); records.set(key, clone(change.record));} else records.delete(key);}
      return change.result;
    },
    async read<T>(key: string): Promise<T | undefined> {
      const saved = records.get(key);
      if (saved && saved.expiresAt > Date.now()) return clone(saved.value) as T;
      records.delete(key); return undefined;
    },
  };
}
