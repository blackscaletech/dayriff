import test from 'node:test';
import assert from 'node:assert/strict';
import {api, RequestError} from '../src/client/api.js';
import {describeFailure, toFailure} from '../src/client/failures.js';
import {tripClearChannel} from '../src/client/trip-clear-channel.js';

test('clearing a trip uses the protected same-origin delete contract without sending trip contents', async t => {
  let calls = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    calls += 1;
    assert.equal(path, '/api/session');
    assert.equal(options.method, 'DELETE');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.signal, controller.signal);
    assert.equal(new Headers(options.headers).get('X-Dayriff-Request'), '1');
    assert.equal(options.body, undefined);
    return Response.json({cleared: true});
  });
  assert.deepEqual(await api.clearSession(controller.signal), {cleared: true});
  assert.equal(calls, 1);
});

test('a failed clear remains a retryable failure instead of reporting a removed trip', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({error: 'Your trip could not be cleared. Please try again.', code: 'STORAGE_UNAVAILABLE'}, {status: 503}));
  await assert.rejects(api.clearSession(), reason => {
    assert.ok(reason instanceof RequestError);
    const failure = toFailure(reason, 'clearTrip');
    assert.equal(describeFailure(failure).title, 'Your trip couldn’t be cleared');
    assert.equal(describeFailure(failure).recovery, 'retry');
    assert.equal(failure.message, 'Your trip could not be cleared. Please try again.');
    return true;
  });
});

test('clearing requires a positive server acknowledgement before local trip data is discarded', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({cleared: false}));
  await assert.rejects(api.clearSession(), reason => reason instanceof RequestError && reason.code === 'INVALID_CLEAR_RESPONSE');
});

test('a clear in one tab resets other tabs without sending contents or repeating a delete', {timeout: 2000}, async () => {
  let localClears = 0, otherClears = 0;
  let received!: () => void;
  const receivedClear = new Promise<void>(resolve => {received = resolve;});
  const first = tripClearChannel(() => localClears++), second = tripClearChannel(() => {otherClears++; received();});
  const observer = new BroadcastChannel('dayriff-trip-clear');
  const payload = new Promise<unknown>(resolve => {observer.onmessage = event => resolve(event.data);});
  try {
    observer.postMessage({trip: 'untrusted'});
    first.publish();
    await receivedClear;
    assert.equal(await payload, 'trip-cleared');
    assert.equal(localClears, 0, 'The sending tab already reset itself and ignores unrelated payloads');
    assert.equal(otherClears, 1);
    second.close();
    const nextPayload = new Promise<unknown>(resolve => {observer.onmessage = event => resolve(event.data);});
    first.publish();
    await nextPayload;
    assert.equal(otherClears, 1, 'Closed tabs no longer receive notifications');
  } finally {first.close(); second.close(); observer.close();}
});

test('unavailable cross-tab messaging does not prevent this tab from clearing its trip', async t => {
  t.mock.method(globalThis, 'BroadcastChannel', class {constructor() {throw new DOMException('Storage is unavailable', 'SecurityError');}} as unknown as typeof BroadcastChannel);
  const channel = tripClearChannel(() => assert.fail('No message should arrive'));
  assert.doesNotThrow(() => {channel.publish(); channel.close();});
});
