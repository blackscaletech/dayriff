import assert from 'node:assert/strict';
import test from 'node:test';
import {copyTripLink, nativeShareAvailable, shareTrip, tripShareUrl} from '../src/client/sharing.js';
import {api} from '../src/client/api.js';

const token = 'a'.repeat(43), link = {shareId: token, path: `/shared/${token}`, expiresAt: '2026-10-23T12:00:00Z'};
test('shared links accept only the matching same-origin capability path', () => {
  assert.equal(tripShareUrl(link, 'https://dayriff.example'), `https://dayriff.example/shared/${token}`);
  for (const path of ['https://other.example/secret', '//other.example/secret', `/shared/${'b'.repeat(43)}`, `${link.path}?origin=private`]) assert.throws(() => tripShareUrl({...link, path}, 'https://dayriff.example'));
  assert.throws(() => tripShareUrl({...link, expiresAt: 'not a date'}, 'https://dayriff.example'));
});
test('native sharing is called directly and cancellation never copies a link', async () => {
  let shares = 0, copies = 0;
  const data = {title: 'Dayriff', url: tripShareUrl(link, 'https://dayriff.example')};
  const navigation = {share: async (received: ShareData) => {shares++; assert.deepEqual(received, data);}, clipboard: {writeText: async () => {copies++;}}};
  const pending = shareTrip(navigation, data);
  assert.equal(shares, 1, 'The share call must happen before awaiting any preparation to retain user activation');
  assert.equal(await pending, 'opened');
  assert.equal(await shareTrip({...navigation, share: async () => {throw new DOMException('Cancelled', 'AbortError');}}, data), 'cancelled');
  assert.equal(copies, 0);
});
test('missing, blocked or rejected native sharing has a graceful copy fallback', async () => {
  const data = {url: 'https://dayriff.example/shared/plan'};
  assert.equal(nativeShareAvailable({}, data), false);
  assert.equal(await shareTrip({}, data), 'unavailable');
  assert.equal(await shareTrip({share: async () => {}, canShare: () => false}, data), 'unavailable');
  assert.equal(await shareTrip({share: async () => {throw new DOMException('No permission', 'NotAllowedError');}}, data), 'unavailable');
  assert.equal(nativeShareAvailable({share: async () => {}, canShare: () => {throw Error('Blocked');}}, data), false);
  let copied = '';
  assert.equal(await copyTripLink({clipboard: {writeText: async text => {copied = text;}}}, data.url), true);
  assert.equal(copied, data.url);
  assert.equal(await copyTripLink({}, data.url), false);
  assert.equal(await copyTripLink({clipboard: {writeText: async () => {throw Error('Denied');}}}, data.url), false, 'UI can show a selectable link when clipboard access is unavailable');
});
test('sharing uses a protected revision-specific request; viewing a shared plan is a read', async () => {
  const original = globalThis.fetch;
  const calls: {url: string; options?: RequestInit}[] = [];
  try {
    globalThis.fetch = async (url, options) => {calls.push({url: String(url), options}); return Response.json(String(url).includes('/api/shared/') ? {itinerary: {stops: [{id: 'public-stop'}]}, expiresAt: link.expiresAt} : link);};
    await api.share('owned-plan', 4);
    assert.equal(calls[0]?.url, '/api/plans/owned-plan/share');
    assert.equal(calls[0]?.options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.options?.body)), {revision: 4});
    assert.equal((calls[0]?.options?.headers as Record<string, string>)['X-Dayriff-Request'], '1');
    await api.sharedTrip(token);
    assert.equal(calls[1]?.url, `/api/shared/${token}`);
    assert.equal(calls[1]?.options?.body, undefined);
    assert.equal(calls[1]?.options?.method, undefined);
    assert.equal(calls[1]?.options?.credentials, 'omit', 'A public view does not send the viewer’s private session cookie');
    globalThis.fetch = async () => Response.json(null);
    await assert.rejects(api.sharedTrip(token), /could not be loaded/);
  } finally {globalThis.fetch = original;}
});
