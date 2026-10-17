import {AsyncLocalStorage} from 'node:async_hooks';
import type {ServerConfig} from '../config.js';
import {ServiceError} from '../errors.js';
import type {StateStore} from '../storage/state-store.js';

type Provider = 'openai' | 'qloo' | 'routes';
interface DailyUsage {plans: number; lookups: number; openai: number; qloo: number; routes: number; sessions: Record<string, number>}
export interface Quotas {
  reservePlan(session: string): Promise<void>;
  reserveLookup(): Promise<void>;
  reserveProvider(provider: Provider): Promise<void>;
}
const DAY = 86_400_000;
const activeQuotas = new AsyncLocalStorage<Quotas>();
function unavailable(): ServiceError {return new ServiceError('Planning is temporarily unavailable. Your saved trip is safe; please try again shortly.', 503, 'QUOTA_UNAVAILABLE');}
function validUsage(value: DailyUsage): boolean {
  return ['plans', 'lookups', 'openai', 'qloo', 'routes'].every(key => Number.isSafeInteger(value[key as keyof Omit<DailyUsage, 'sessions'>]) && Number(value[key as keyof Omit<DailyUsage, 'sessions'>]) >= 0)
    && !!value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
    && Object.values(value.sessions).every(count => Number.isSafeInteger(count) && count >= 0);
}
/** A single small daily document makes global and browser reservations atomic across instances. */
export function createQuotas(config: ServerConfig, store: StateStore, now: () => number = Date.now): Quotas {
  async function reserve(kind: 'plans' | 'lookups' | Provider, session?: string): Promise<void> {
    const timestamp = now(), day = new Date(timestamp).toISOString().slice(0, 10);
    const limit = kind === 'plans' ? config.maxDailyPlans : kind === 'lookups' ? config.maxDailyLookups : kind === 'openai' ? config.maxDailyOpenaiRequests ?? 400 : kind === 'qloo' ? config.maxDailyQlooRequests ?? 2000 : config.maxDailyRoutesRequests ?? 300;
    try {
      const failure = await store.transact<DailyUsage, 'global' | 'session' | undefined>(`quota:${day}`, current => {
        const usage = current ?? {plans: 0, lookups: 0, openai: 0, qloo: 0, routes: 0, sessions: {}};
        if (!validUsage(usage)) throw unavailable();
        if (usage[kind] >= limit) return {unchanged: true, result: 'global'};
        if (session && (usage.sessions[session] ?? 0) >= (config.maxSessionDailyPlans ?? 30)) return {unchanged: true, result: 'session'};
        const next = {...usage, [kind]: usage[kind] + 1, sessions: {...usage.sessions}};
        if (session) next.sessions[session] = (next.sessions[session] ?? 0) + 1;
        return {record: {value: next, expiresAt: Math.floor(timestamp / DAY) * DAY + 3 * DAY}, result: undefined};
      });
      if (failure === 'session') throw new ServiceError('You have reached today’s planning allowance for this browser. Your saved trip is still available; try more changes tomorrow.', 429, 'SESSION_DAILY_LIMIT');
      if (failure === 'global') {
        const code = kind === 'plans' ? 'DAILY_LIMIT' : kind === 'lookups' ? 'DAILY_SEARCH_LIMIT' : 'PROVIDER_DAILY_LIMIT';
        const message = kind === 'lookups' ? 'Search is at capacity for today. Please try again tomorrow.' : 'Dayriff has reached its daily planning allowance. Your saved trip is still available; please try again tomorrow.';
        throw new ServiceError(message, 429, code);
      }
    } catch (error) {
      if (error instanceof ServiceError && ['DAILY_LIMIT', 'DAILY_SEARCH_LIMIT', 'SESSION_DAILY_LIMIT', 'PROVIDER_DAILY_LIMIT'].includes(error.code)) throw error;
      throw unavailable();
    }
  }
  return {reservePlan: session => reserve('plans', session), reserveLookup: () => reserve('lookups'), reserveProvider: provider => reserve(provider)};
}
export function withProviderQuotas<T>(quotas: Quotas, task: () => T): T {return activeQuotas.run(quotas, task);}
/** Reserve every actual outbound attempt, including a retried read; cached results spend no calls. */
export async function reserveProviderRequest(url: string | URL): Promise<void> {
  const quotas = activeQuotas.getStore(); if (!quotas) return;
  const hostname = new URL(url).hostname;
  const provider = hostname === 'api.openai.com' ? 'openai' : ['api.qloo.com', 'hackathon.api.qloo.com'].includes(hostname) ? 'qloo' : hostname === 'routes.googleapis.com' ? 'routes' : undefined;
  if (provider) await quotas.reserveProvider(provider);
}
