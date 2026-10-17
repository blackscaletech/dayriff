import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchJson, ServiceError} from '../src/server/providers/http.js';

test('rate-limited reads retry once, while mutations and long provider waits do not retry', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => ++calls === 1 ? new Response('{}', {status: 429, headers: {'Retry-After': '0'}}) : new Response('{"ok":true}');
    assert.deepEqual(await fetchJson('https://api.qloo.com/search', {}, 'Qloo'), {ok: true});
    assert.equal(calls, 2);
    for (const [method, retryAfter] of [['POST', '0'], ['GET', '60']] as const) {
      calls = 0;
      globalThis.fetch = async () => {calls++; return new Response('{}', {status: 429, headers: {'Retry-After': retryAfter}});};
      await assert.rejects(fetchJson('https://api.qloo.com/search', {method}, 'Qloo'), (error: unknown) => error instanceof ServiceError && error.code === 'PROVIDER_BUSY');
      assert.equal(calls, 1);
    }
    calls = 0;
    globalThis.fetch = async () => {calls++; return new Response('{}', {status: 429, headers: {'Retry-After': '0'}});};
    await assert.rejects(fetchJson('https://api.qloo.com/search', {}, 'Qloo'), (error: unknown) => error instanceof ServiceError && error.code === 'PROVIDER_BUSY');
    assert.equal(calls, 2, 'Persistent rate limits do not create a retry loop');
  } finally {globalThis.fetch = original;}
});
