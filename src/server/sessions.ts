import {randomBytes} from 'node:crypto';
import type {FastifyReply, FastifyRequest} from 'fastify';
import type {SessionState} from './routes.js';
import type {ServerConfig} from './config.js';
import {ServiceError} from './errors.js';
import {createMemoryStateStore, type StateStore} from './storage/state-store.js';

export const SESSION_COOKIE_NAME = 'dayriff_session';
export const SESSION_RETENTION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const LEASE_MS = 130_000; // The complete provider operation is bounded to 120 seconds.
interface Entry {state: SessionState; revision: number; expiresAt: number; lease?: {token: string; until: number}}
interface Context {id: string; state: SessionState}
export interface Sessions {
  (request: FastifyRequest, reply: FastifyReply): Promise<SessionState>;
  identity(request: FastifyRequest, reply: FastifyReply): Promise<string>;
  mutate<T>(request: FastifyRequest, reply: FastifyReply, task: (state: SessionState) => Promise<T>): Promise<T>;
  update(request: FastifyRequest, reply: FastifyReply, state: SessionState): Promise<void>;
  clear(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}
function initialState(): SessionState {return {messages: [], artists: [], venues: [], cities: [], excludedIds: [], history: []};}
function remember<T extends {id: string}>(first: T[], next: T[]): T[] {return [...new Map([...first, ...next].map(item => [item.id, item])).values()].slice(-40);}
function mergeSearches(state: SessionState, current: SessionState): SessionState {
  return {...state, artists: remember(state.artists, current.artists), venues: remember(state.venues, current.venues), cities: remember(state.cities, current.cities)};
}
function changed(): never {throw new ServiceError('This trip changed in another window. Your saved plan is safe; reopen it before trying again.', 409, 'PLAN_CHANGED');}
function sessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE_NAME], unsigned = raw ? request.unsignCookie(raw) : undefined;
  return unsigned?.valid && unsigned.value && /^[A-Za-z0-9_-]{43}$/.test(unsigned.value) ? unsigned.value : undefined;
}
export function createSessions(config: ServerConfig, store: StateStore = createMemoryStateStore()): Sessions {
  const lifetime = (config.sessionRetentionDays ?? SESSION_RETENTION_DAYS) * DAY;
  const contexts = new WeakMap<FastifyRequest, Context>();
  const key = (id: string) => `session:${id}`;
  function renew(reply: FastifyReply, id: string) {
    reply.setCookie(SESSION_COOKIE_NAME, id, {path: '/', httpOnly: true, sameSite: 'strict', secure: config.production, signed: true, maxAge: lifetime / 1000});
  }
  async function context(request: FastifyRequest, reply: FastifyReply): Promise<Context> {
    const cached = contexts.get(request); if (cached) return cached;
    const trusted = sessionId(request), now = Date.now();
    let id = trusted;
    let entry = trusted ? await store.transact<Entry, Entry | undefined>(key(trusted), current => {
      if (!current) return {unchanged: true, result: undefined};
      const next = {...current, expiresAt: now + lifetime};
      return {record: {value: next, expiresAt: next.expiresAt}, result: next};
    }) : undefined;
    if (!entry) {
      id = randomBytes(32).toString('base64url');
      entry = {state: initialState(), revision: 0, expiresAt: now + lifetime};
      const created = entry;
      await store.transact<Entry, void>(key(id), current => {if (current) changed(); return {record: {value: created, expiresAt: created.expiresAt}, result: undefined};});
    }
    const result = {id: id!, state: structuredClone(entry.state)};
    contexts.set(request, result); renew(reply, result.id); return result;
  }
  const get = (async (request: FastifyRequest, reply: FastifyReply) => (await context(request, reply)).state) as Sessions;
  get.identity = async (request, reply) => (await context(request, reply)).id;
  get.update = async (request, reply, state) => {
    const {id} = await context(request, reply);
    await store.transact<Entry, void>(key(id), current => {
      if (!current) changed();
      const next = {...current, state: {...current.state, artists: remember(current.state.artists, state.artists), venues: remember(current.state.venues, state.venues), cities: remember(current.state.cities, state.cities)}};
      return {record: {value: next, expiresAt: next.expiresAt}, result: undefined};
    });
  };
  get.mutate = async (request, reply, task) => {
    const {id} = await context(request, reply), token = randomBytes(24).toString('base64url');
    const acquired = await store.transact<Entry, Entry>(key(id), current => {
      if (!current) changed();
      if (current.lease && current.lease.until > Date.now()) throw new ServiceError('Your plan is already being updated. Please wait a moment.', 409, 'PLAN_BUSY');
      const next = {...current, lease: {token, until: Date.now() + LEASE_MS}};
      return {record: {value: next, expiresAt: next.expiresAt}, result: next};
    });
    const draft = structuredClone(acquired.state);
    try {
      const result = await task(draft);
      delete draft.busy;
      await store.transact<Entry, void>(key(id), current => {
        if (!current || current.revision !== acquired.revision || current.lease?.token !== token || current.lease.until <= Date.now()) changed();
        const next: Entry = {state: mergeSearches(draft, current.state), revision: current.revision + 1, expiresAt: Date.now() + lifetime};
        return {record: {value: next, expiresAt: next.expiresAt}, result: undefined};
      });
      return result;
    } finally {
      // Never recreate a record removed by Clear trip or overwrite a newer lease.
      await store.transact<Entry, void>(key(id), current => {
        if (!current || current.lease?.token !== token) return {unchanged: true, result: undefined};
        const next = {...current}; delete next.lease;
        return {record: {value: next, expiresAt: next.expiresAt}, result: undefined};
      });
    }
  };
  get.clear = async (request, reply) => {
    const id = contexts.get(request)?.id ?? sessionId(request);
    if (id) await store.transact<Entry, void>(key(id), () => ({result: undefined}));
    contexts.delete(request);
    reply.clearCookie(SESSION_COOKIE_NAME, {path: '/', httpOnly: true, sameSite: 'strict', secure: config.production});
  };
  return get;
}
