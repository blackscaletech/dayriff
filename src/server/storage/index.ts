import {resolve} from 'node:path';
import type {ServerConfig} from '../config.js';
import {createFileStateStore} from './file-store.js';
import {createMemoryStateStore, type StateStore} from './state-store.js';
export type {StateStore, StoredValue, StoreChange} from './state-store.js';
export {createMemoryStateStore} from './state-store.js';

export async function createStateStore(config: ServerConfig): Promise<StateStore> {
  const backend = config.storageBackend ?? (config.production ? 'firestore' : 'file');
  if (config.production && backend !== 'firestore') throw new Error('Production requires shared Firestore storage.');
  if (backend === 'memory') return createMemoryStateStore();
  if (backend === 'firestore') {
    const {createFirestoreStateStore} = await import('./firestore-store.js');
    return createFirestoreStateStore(config.firestoreProjectId, config.firestoreDatabaseId);
  }
  return createFileStateStore(config.storageDirectory ?? resolve('.private/state'));
}
