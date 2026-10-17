import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpServer} from '../src/server/app.js';
import {canonicalRedirectUrl} from '../src/server/canonical-origin.js';
import {registerSecurity} from '../src/server/security.js';
import {createMemoryStateStore} from '../src/server/storage/index.js';
import type {ServerConfig} from '../src/server/config.js';

const config: ServerConfig = {mode: 'live', production: true, port: 8080, host: '0.0.0.0', appOrigin: 'https://dayriff.com',
  cookieSecret: 'canonical-tests-stable-cookie-secret-32chars', qlooApiUrl: 'https://hackathon.api.qloo.com', openaiModel: 'test', openaiReasoningEffort: 'medium', maxDailyPlans: 100, maxDailyLookups: 2000};
async function fixture(settings: ServerConfig = config) {
  const app = createHttpServer(settings);
  await registerSecurity(app, settings, false, createMemoryStateStore());
  let requests = 0;
  app.get('/healthz', async () => ({status: 'ok'}));
  app.get('/*', async () => {requests++; return {ok: true};});
  app.post('/api/plans', async () => {requests++; return {ok: true};});
  return {app, requests: () => requests};
}

test('only the configured live www alias redirects, keeping public share paths and encoded queries', async () => {
  const {app, requests} = await fixture();
  try {
    for (const host of ['www.dayriff.com', 'WWW.DAYRIFF.COM', 'www.dayriff.com:443']) {
      const response = await app.inject({url: '/shared/abc?source=friend&name=A%20B&next=https%3A%2F%2Fexample.com', headers: {host}});
      assert.equal(response.statusCode, 308);
      assert.equal(response.headers.location, 'https://dayriff.com/shared/abc?source=friend&name=A%20B&next=https%3A%2F%2Fexample.com');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer');
    }
    const head = await app.inject({method: 'HEAD', url: '/?new=1', headers: {host: 'www.dayriff.com'}});
    assert.equal(head.statusCode, 308); assert.equal(head.headers.location, 'https://dayriff.com/?new=1'); assert.equal(head.body, '');
    assert.equal(requests(), 0, 'Redirects precede app handlers and private session work');
  } finally {await app.close();}
});

test('arbitrary Host or forwarded headers never control the redirect destination or activate an alias', async () => {
  const {app} = await fixture();
  try {
    for (const host of ['dayriff.com', 'attacker.invalid', 'www.dayriff.com.attacker.invalid', 'www.dayriff.com:8443', 'user@www.dayriff.com']) {
      const response = await app.inject({url: '/', headers: {host, 'x-forwarded-host': 'www.dayriff.com', 'x-forwarded-proto': 'https'}});
      assert.equal(response.statusCode, 200, host); assert.equal(response.headers.location, undefined, host);
    }
    const alias = await app.inject({url: '/', headers: {host: 'www.dayriff.com', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'http'}});
    assert.equal(alias.headers.location, 'https://dayriff.com/');
  } finally {await app.close();}
});

test('alias redirects reject authority-changing or header-injecting raw request targets', () => {
  // HTTP injection clients normalize backslashes/fragments before Fastify sees them;
  // exercise the raw-target parser itself so those cases remain covered.
  for (const target of ['https://attacker.invalid/path', '//attacker.invalid/path', '/\\attacker.invalid/path', '/path#fragment', '/path\r\nLocation: https://attacker.invalid']) {
    assert.equal(canonicalRedirectUrl(config.appOrigin!, target), undefined, JSON.stringify(target));
  }
  for (const target of ['/shared/token?next=https://attacker.invalid', '/%2f%2fattacker.invalid', '/path?value=%0d%0aLocation%3Aevil']) {
    const result = canonicalRedirectUrl(config.appOrigin!, target);
    assert.equal(result?.origin, config.appOrigin); assert.ok(!/[\r\n]/.test(result!.href));
  }
});

test('health checks, mutations, local development and sample mode retain their existing behavior', async () => {
  const {app} = await fixture();
  try {
    const health = await app.inject({url: '/healthz?probe=1', headers: {host: 'www.dayriff.com'}});
    assert.equal(health.statusCode, 200); assert.deepEqual(health.json(), {status: 'ok'}); assert.equal(health.headers.location, undefined);
    const mutation = await app.inject({method: 'POST', url: '/api/plans', headers: {host: 'www.dayriff.com', origin: 'https://www.dayriff.com', 'x-dayriff-request': '1'}});
    assert.equal(mutation.statusCode, 403); assert.equal(mutation.headers.location, undefined, 'Do not replay a mutation across origins');
  } finally {await app.close();}
  for (const settings of [{...config, production: false}, {...config, mode: 'sample' as const}, {...config, appOrigin: undefined}, {...config, appOrigin: 'https://www.dayriff.com'}]) {
    const {app} = await fixture(settings);
    try {const response = await app.inject({url: '/', headers: {host: 'www.dayriff.com'}}); assert.equal(response.statusCode, 200); assert.equal(response.headers.location, undefined);}
    finally {await app.close();}
  }
});
