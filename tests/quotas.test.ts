import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadConfig} from '../src/server/config.js';
import {createHttpServer} from '../src/server/app.js';
import {registerSecurity} from '../src/server/security.js';
import {ServiceError, fetchJson} from '../src/server/providers/http.js';
import {createQuotas, withProviderQuotas} from '../src/server/services/quotas.js';
import {createMemoryStateStore, type StateStore} from '../src/server/storage/state-store.js';
import {createFileStateStore} from '../src/server/storage/file-store.js';

const config = loadConfig({MAX_DAILY_PLANS: '5', MAX_DAILY_LOOKUPS: '3', MAX_SESSION_DAILY_PLANS: '2', MAX_DAILY_OPENAI_REQUESTS: '2', MAX_DAILY_QLOO_REQUESTS: '1', MAX_DAILY_ROUTES_REQUESTS: '1'});
const limited = (code: string) => (error: unknown) => error instanceof ServiceError && error.statusCode === 429 && error.code === code;

test('atomic shared quotas enforce browser, global, search and UTC day limits without denial writes', async () => {
  const store = createMemoryStateStore(); let timestamp = Date.UTC(2026, 9, 16, 23, 59, 59);
  const first = createQuotas(config, store, () => timestamp), second = createQuotas(config, store, () => timestamp);
  const outcomes = await Promise.allSettled(Array.from({length: 8}, (_, index) => (index % 2 ? first : second).reservePlan('browser-one')));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 2);
  assert.ok(outcomes.filter(outcome => outcome.status === 'rejected').every(outcome => limited('SESSION_DAILY_LIMIT')(outcome.reason)));
  await second.reservePlan('browser-two'); await first.reservePlan('browser-two'); await first.reservePlan('browser-three');
  await assert.rejects(second.reservePlan('browser-four'), limited('DAILY_LIMIT'));
  for (let index = 0; index < 3; index++) await first.reserveLookup();
  await assert.rejects(second.reserveLookup(), limited('DAILY_SEARCH_LIMIT'));
  timestamp += 2000;
  await second.reservePlan('browser-one'); await second.reserveLookup();
  assert.deepEqual((await store.read<{plans: number}>('quota:2026-10-16'))?.plans, 5, 'Rejected reservations leave the prior count unchanged');
});

test('quota reservations survive recreation and remain atomic between local server instances', async () => {
  const directory = await mkdtemp(resolve('.private/quota-test-'));
  try {
    const first = createQuotas({...config, maxSessionDailyPlans: 10}, await createFileStateStore(directory));
    const second = createQuotas({...config, maxSessionDailyPlans: 10}, await createFileStateStore(directory));
    const outcomes = await Promise.allSettled(Array.from({length: 14}, (_, index) => (index % 2 ? first : second).reservePlan(`browser-${index}`)));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 5);
    const restarted = createQuotas(config, await createFileStateStore(directory));
    await assert.rejects(restarted.reservePlan('another-browser'), limited('DAILY_LIMIT'));
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('provider reservations count each network attempt and stop before the cap or unavailable store', async () => {
  const original = globalThis.fetch; let calls = 0;
  const quotas = createQuotas(config, createMemoryStateStore());
  try {
    globalThis.fetch = async () => {calls++; return new Response('{}', {status: 429, headers: {'Retry-After': '0'}});};
    await assert.rejects(withProviderQuotas(quotas, () => fetchJson('https://api.qloo.com/search', {}, 'Qloo')), limited('PROVIDER_DAILY_LIMIT'));
    assert.equal(calls, 1, 'A retry is not sent when the next reservation is denied');
    globalThis.fetch = async () => {calls++; return new Response('{"ok":true}');};
    await withProviderQuotas(quotas, () => fetchJson('https://api.openai.com/v1/responses', {method: 'POST'}, 'OpenAI'));
    await withProviderQuotas(quotas, () => fetchJson('https://api.openai.com/v1/responses', {method: 'POST'}, 'OpenAI'));
    await assert.rejects(withProviderQuotas(quotas, () => fetchJson('https://api.openai.com/v1/responses', {method: 'POST'}, 'OpenAI')), limited('PROVIDER_DAILY_LIMIT'));
    assert.equal(calls, 3);
    await withProviderQuotas(quotas, () => fetchJson('https://routes.googleapis.com/directions/v2:computeRoutes', {method: 'POST'}, 'Google Routes'));
    await assert.rejects(withProviderQuotas(quotas, () => fetchJson('https://routes.googleapis.com/directions/v2:computeRoutes', {method: 'POST'}, 'Google Routes')), limited('PROVIDER_DAILY_LIMIT'));
    const broken: StateStore = {read: async () => {throw Error('private storage detail');}, transact: async () => {throw Error('private storage detail');}};
    await assert.rejects(withProviderQuotas(createQuotas(config, broken), () => fetchJson('https://api.openai.com/v1/responses', {method: 'POST'}, 'OpenAI')), error => error instanceof ServiceError && error.statusCode === 503 && error.code === 'QUOTA_UNAVAILABLE' && !error.message.includes('private storage detail'));
    assert.equal(calls, 4, 'An unavailable quota store must not permit an uncounted provider call');
  } finally {globalThis.fetch = original;}
});

test('route handlers carry isolated provider budgets, reject cross-site drain and keep clear available', async () => {
  const store = createMemoryStateStore(), local = {...config, maxDailyPlans: 1, maxDailyOpenaiRequests: 1};
  const app = createHttpServer(local), original = globalThis.fetch; let calls = 0;
  await registerSecurity(app, local, false, store);
  app.post('/api/plans', async () => {await Promise.resolve(); return fetchJson('https://api.openai.com/v1/responses', {method: 'POST'}, 'OpenAI');});
  app.get('/api/answer', async () => fetchJson('https://api.openai.com/v1/responses', {method: 'POST'}, 'OpenAI'));
  app.get('/api/session', async () => ({saved: true}));
  app.delete('/api/session', async () => ({cleared: true}));
  const headers = {'x-dayriff-request': '1'};
  try {
    globalThis.fetch = async () => {calls++; return new Response('{"ok":true}');};
    assert.equal((await app.inject({method: 'POST', url: '/api/plans', headers: {...headers, 'sec-fetch-site': 'cross-site'}})).statusCode, 403);
    assert.equal((await app.inject({method: 'POST', url: '/api/plans', headers})).statusCode, 200);
    const capped = await app.inject({method: 'POST', url: '/api/plans', headers});
    assert.equal(capped.statusCode, 429); assert.equal(capped.json().code, 'DAILY_LIMIT'); assert.ok(Number(capped.headers['retry-after']) > 0);
    const providerCap = await app.inject('/api/answer');
    assert.equal(providerCap.statusCode, 429); assert.equal(providerCap.json().code, 'PROVIDER_DAILY_LIMIT'); assert.equal(calls, 1);
    assert.equal((await app.inject('/api/session')).statusCode, 200);
    assert.equal((await app.inject({method: 'DELETE', url: '/api/session', headers})).statusCode, 200);
    assert.equal((await app.inject({method: 'DELETE', url: '/api/session'})).statusCode, 403);
  } finally {globalThis.fetch = original; await app.close();}
});
