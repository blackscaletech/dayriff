import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerSecurity } from '../src/server/security.js';
import { loadConfig } from '../src/server/config.js';
import { createHttpServer, registerErrorHandler } from '../src/server/app.js';
import { ServiceError } from '../src/server/providers/http.js';

test('mutations require the app header and same-origin context', async () => {
  const app = Fastify();
  await registerSecurity(app, loadConfig({ APP_ORIGIN: 'http://localhost:3000' }), false);
  app.post('/api/plans', async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/plans' })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/plans', headers: { 'x-dayriff-request': '1', origin: 'https://other.example' } })).statusCode, 403);
    const accepted = await app.inject({ method: 'POST', url: '/api/plans', headers: { 'x-dayriff-request': '1', origin: 'http://localhost:3000' } });
    assert.equal(accepted.statusCode, 200);
    assert.match(accepted.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
    assert.equal(accepted.headers['cache-control'], 'no-store');
  } finally { await app.close(); }
});

test('history deletion uses mutation request protection without consuming provider planning allowance', async () => {
  const app = Fastify();
  await registerSecurity(app, loadConfig({APP_ORIGIN: 'http://localhost:3000', MAX_DAILY_PLANS: '1'}), false);
  app.delete('/api/plans/:id/history/:versionId', async () => ({history: []}));
  app.post('/api/plans', async () => ({ok: true}));
  const url = '/api/plans/11111111-1111-4111-8111-111111111111/history/22222222-2222-4222-8222-222222222222';
  const headers = {'x-dayriff-request': '1', origin: 'http://localhost:3000'};
  try {
    assert.equal((await app.inject({method: 'DELETE', url})).statusCode, 403);
    assert.equal((await app.inject({method: 'DELETE', url, headers: {...headers, origin: 'https://other.example'}})).statusCode, 403);
    assert.equal((await app.inject({method: 'DELETE', url, headers: {...headers, 'sec-fetch-site': 'cross-site'}})).statusCode, 403);
    const accepted = await app.inject({method: 'DELETE', url, headers});
    assert.equal(accepted.statusCode, 200); assert.deepEqual(accepted.json(), {history: []});
    assert.equal(accepted.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({method: 'POST', url: '/api/plans', headers})).statusCode, 200, 'Removing history must not use the provider planning allowance');
    assert.equal((await app.inject({method: 'DELETE', url, headers})).statusCode, 200, 'History remains removable after the daily provider allowance is used');
    const planningLimit = await app.inject({method: 'POST', url: '/api/plans', headers});
    assert.equal(planningLimit.statusCode, 429); assert.equal(planningLimit.json().code, 'DAILY_LIMIT');
  } finally {await app.close();}
});

test('live and production configuration fail closed without credentials', () => {
  assert.throws(() => loadConfig({ APP_MODE: 'live' }), /requires/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => loadConfig({ QLOO_API_URL: 'https://api.qloo.com.evil.example' }), /official Qloo/);
  assert.equal(loadConfig({}).mode, 'sample');
});

test('known 400 and 409 errors retain their friendly message and code', async () => {
  const app = Fastify();
  registerErrorHandler(app);
  app.get('/invalid', () => { throw new ServiceError('Choose an artist from the search suggestions.', 400, 'INVALID_INPUT'); });
  app.get('/busy', () => { throw new ServiceError('Your plan is already being updated. Please wait a moment.', 409, 'PLAN_BUSY'); });
  try {
    const invalid = await app.inject('/invalid');
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), {error: 'Choose an artist from the search suggestions.', code: 'INVALID_INPUT'});
    const busy = await app.inject('/busy');
    assert.equal(busy.statusCode, 409);
    assert.deepEqual(busy.json(), {error: 'Your plan is already being updated. Please wait a moment.', code: 'PLAN_BUSY'});
  } finally { await app.close(); }
});

test('read traffic has a separate bucket and exhausted mutation limits return friendly 429 responses', async () => {
  const app = Fastify();
  registerErrorHandler(app);
  await registerSecurity(app, loadConfig({APP_MODE: 'sample'}), false);
  app.get('/read', async () => ({ok: true}));
  app.post('/api/plans', async () => ({ok: true}));
  app.delete('/api/plans/:id/history/:versionId', async () => ({history: []}));
  const request = {method: 'POST' as const, url: '/api/plans', headers: {'x-dayriff-request': '1'}};
  try {
    for (let index = 0; index < 11; index++) assert.equal((await app.inject('/read')).statusCode, 200);
    assert.equal((await app.inject(request)).statusCode, 200, 'Read requests must not consume the smaller planning allowance');
    const deletion = {method: 'DELETE' as const, url: '/api/plans/plan/history/version', headers: request.headers};
    for (let index = 0; index < 9; index++) assert.equal((await app.inject(index % 2 ? request : deletion)).statusCode, 200);
    const limited = await app.inject(deletion);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), {error: 'A little too fast. Please wait a minute and try again.', code: 'RATE_LIMITED'});
  } finally { await app.close(); }
});

test('bounded planning handlers keep their response socket open beyond ten seconds', async () => {
  const app = createHttpServer(loadConfig({APP_MODE: 'sample'}));
  try {
    await app.ready();
    assert.equal(app.server.timeout, 0, 'Provider timeouts bound planning work; an idle socket must not terminate it early');
    assert.ok(app.server.requestTimeout > 0, 'Request-body timeout remains bounded');
    assert.ok(app.server.headersTimeout > 0, 'Header timeout remains bounded');
  } finally { await app.close(); }
});
