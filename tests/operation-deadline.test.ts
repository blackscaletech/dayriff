import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as pause} from 'node:timers/promises';
import {fetchJson, ServiceError} from '../src/server/providers/http.js';
import {assertPlanActive, planOperationSignal, withPlanDeadline} from '../src/server/services/operation-deadline.js';

test('a shared deadline aborts provider work and preserves the timeout provenance', async () => {
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {aborted = true; reject(new Error('provider aborted'));}, {once: true});
  });
  try {
    await assert.rejects(withPlanDeadline(() => fetchJson('https://api.qloo.com/test', {}, 'Provider', 30_000), 20),
      (error: unknown) => error instanceof ServiceError && error.code === 'PLAN_TIMEOUT' && error.statusCode === 504);
    assert.equal(aborted, true);
    assert.equal(planOperationSignal(), undefined, 'Deadlines stay isolated to their operation');
  } finally {globalThis.fetch = original;}
});

test('nested work shares one deadline and a fallback cannot commit after it expires', async () => {
  let committed = false;
  await assert.rejects(withPlanDeadline(async () => {
    const outer = planOperationSignal();
    await withPlanDeadline(async () => {assert.equal(planOperationSignal(), outer); await pause(30);}, 60_000);
    assertPlanActive();
    committed = true;
  }, 10), (error: unknown) => error instanceof ServiceError && error.code === 'PLAN_TIMEOUT');
  assert.equal(committed, false);
  assert.equal(await withPlanDeadline(async () => 'ready', 100), 'ready');
});
