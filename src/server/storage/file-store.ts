import {createHash, randomUUID} from 'node:crypto';
import {chmod, mkdir, readFile, rename, rm, stat, writeFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {ServiceError} from '../errors.js';
import {clone, encodeRecord, storageUnavailable, validateRecord, type StateStore, type StoredValue, type StoreChange} from './state-store.js';

function missing(error: unknown): boolean {return (error as NodeJS.ErrnoException).code === 'ENOENT';}
export async function createFileStateStore(directory: string): Promise<StateStore> {
  await mkdir(directory, {recursive: true, mode: 0o700}); await chmod(directory, 0o700);
  const filename = (key: string) => resolve(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  async function read<T>(path: string): Promise<StoredValue<T> | undefined> {
    try {return validateRecord<T>(JSON.parse(await readFile(path, 'utf8')));} catch (error) {if (missing(error)) return undefined; throw error;}
  }
  async function locked<R>(path: string, task: () => Promise<R>): Promise<R> {
    const lock = `${path}.lock`, started = Date.now(); let acquired = false;
    try {
      while (!acquired) {
        try {await mkdir(lock, {mode: 0o700}); acquired = true;} catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          try {if (Date.now() - (await stat(lock)).mtimeMs > 30_000) {await rm(lock, {recursive: true, force: true}); continue;}} catch (error) {if (!missing(error)) throw error;}
          if (Date.now() - started > 5000) throw storageUnavailable();
          await pause(25);
        }
      }
      return await task();
    } finally {if (acquired) await rm(lock, {recursive: true, force: true});}
  }
  async function cleanup() {
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = resolve(directory, name);
      await locked(path, async () => {const saved = await read<unknown>(path); if (saved && saved.expiresAt <= Date.now()) await rm(path, {force: true});});
    }
  }
  await cleanup();
  const timer = setInterval(() => {void cleanup().catch(() => {});}, 60 * 60 * 1000); timer.unref();
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {const saved = await read<T>(filename(key)); return saved && saved.expiresAt > Date.now() ? clone(saved.value) : undefined;} catch {throw storageUnavailable();}
    },
    async transact<T, R>(key: string, update: (current: T | undefined) => StoreChange<T, R>): Promise<R> {
      const path = filename(key);
      try {
        return await locked(path, async () => {
          const saved = await read<T>(path), current = saved && saved.expiresAt > Date.now() ? clone(saved.value) : undefined;
          const change = update(current);
          if (change.unchanged) return change.result;
          if (change.record) {
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {await writeFile(temporary, encodeRecord(change.record), {mode: 0o600, flag: 'wx'}); await rename(temporary, path);} finally {await rm(temporary, {force: true});}
          } else await rm(path, {force: true});
          return change.result;
        });
      } catch (error) {if (error instanceof ServiceError) throw error; throw storageUnavailable();}
    },
    async close() {clearInterval(timer);},
  };
}
