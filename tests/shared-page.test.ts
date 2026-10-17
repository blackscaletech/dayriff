import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createHttpServer} from '../src/server/app.js';
import {registerSecurity} from '../src/server/security.js';
import {createSessions} from '../src/server/sessions.js';
import {registerSharedRoutes} from '../src/server/shared-routes.js';
import {registerSharedPageRoutes} from '../src/server/shared-page-routes.js';
import {createSharedTrips, publicTrip} from '../src/server/services/shared-trips.js';
import {sharedPageMetadata, sharedPageOrigin, renderSharedPage} from '../src/server/services/shared-page.js';
import {createMemoryStateStore, type StateStore} from '../src/server/storage/index.js';
import type {SessionState} from '../src/server/routes.js';
import type {ServerConfig} from '../src/server/config.js';
import type {Itinerary} from '../src/shared/types.js';
import {sampleArtists, samplePlaces, sampleVenues} from '../src/server/data/catalog.js';
import {checkPlan} from '../src/server/services/planner.js';

const config: ServerConfig = {mode: 'sample', port: 3000, host: '127.0.0.1', production: false,
  qlooApiUrl: 'https://hackathon.api.qloo.com', openaiModel: 'test', openaiReasoningEffort: 'medium',
  cookieSecret: 'test-only-share-page-signing-secret-32-chars', appOrigin: 'https://dayriff.example', maxDailyPlans: 100, maxDailyLookups: 10};
const template = '<!doctype html><html><head><meta charset="UTF-8"><title>Old generic title</title><meta name="description" content="Old generic description"><meta property="og:title" content="Old OG"><meta name="twitter:card" content="summary"><link rel="canonical" href="https://old.example/"><link rel="icon" href="/favicon.svg"><script type="application/ld+json">{"name":"Homepage schema"}</script></head><body><div id="root"></div><noscript data-dayriff-fallback><p>Old homepage instructions.</p></noscript><script type="module" src="/assets/app.js"></script></body></html>';
async function fixture(): Promise<Itinerary> {
  const venue = sampleVenues[0]!, candidates = samplePlaces.filter(place => place.category !== 'food').slice(0, 2);
  const result = await checkPlan({ids: candidates.map(place => place.id), input: {artist: sampleArtists[0]!, venueId: venue.id,
    date: '2026-10-22', showTime: '19:00', durationMinutes: 480, startingPoint: 'Private hotel room 418', budget: 'high'}, venue, candidates, mode: 'sample'});
  assert.ok(result.itinerary);
  result.itinerary.stops[0]!.image = {url: 'https://images.example/first-place.jpg', alt: 'First place'};
  result.itinerary.venue.image = {url: 'https://images.example/concert.jpg', alt: 'Venue'};
  return result.itinerary;
}
function state(itinerary: Itinerary): SessionState {return {itinerary, messages: [{role: 'user', text: 'Private chat'}], artists: [], venues: [], cities: [], excludedIds: [], history: []};}
async function pageApp() {
  const inner = createMemoryStateStore(); let writes = 0;
  const store: StateStore = {...inner, async transact(key, update) {writes++; return inner.transact(key, update);}};
  const app = createHttpServer(config);
  await registerSecurity(app, config, false, store);
  const sessions = createSessions(config, store);
  await registerSharedRoutes(app, sessions, store);
  await registerSharedPageRoutes(app, {config, store, template: async () => template});
  const plan = await fixture(), draft = state(plan), ownerId = randomBytes(32).toString('base64url');
  const link = await createSharedTrips(store).publish(draft, ownerId);
  await store.transact(`session:${ownerId}`, () => ({record: {value: {state: draft}, expiresAt: Date.now() + 30 * 86_400_000}, result: undefined}));
  return {app, link, plan, store, ownerId, writeCount: () => writes};
}

test('a social bot receives per-trip facts and the branded homepage screenshot directly in HTML without JS or sessions', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => {throw new Error('Metadata must not call providers');});
  const {app, link, plan, writeCount} = await pageApp();
  try {
    const writesBefore = writeCount();
    const response = await app.inject({url: link.path, headers: {'user-agent': 'Twitterbot/1.0', host: 'untrusted-host.example'}});
    assert.equal(response.statusCode, 200); assert.match(String(response.headers['content-type']), /text\/html/);
    assert.ok(response.body.includes(`${plan.venue.city} with ${plan.input.artist.name} | Dayriff`));
    for (const expected of [plan.stops[0]!.name, plan.stops[1]!.name, plan.venue.name, 'Oct 22, 2026', '7:00 PM']) assert.ok(response.body.includes(expected), expected);
    assert.ok(response.body.includes('property="og:image" content="https://dayriff.example/share-dayriff.jpg"'));
    assert.ok(response.body.includes('name="twitter:image" content="https://dayriff.example/share-dayriff.jpg"'));
    assert.ok(!response.body.includes('https://images.example/'), 'Social previews use the branded screenshot rather than provider images');
    assert.ok(response.body.includes('property="og:url" content="https://dayriff.example' + link.path + '"'));
    assert.ok(response.body.includes('name="twitter:card" content="summary_large_image"'));
    assert.ok(response.body.includes('property="og:site_name" content="Dayriff"'));
    for (const privateText of ['Private hotel room 418', 'Private chat', 'budget', 'Old generic', 'Old OG', 'Old homepage instructions.', 'Homepage schema', 'https://old.example/', 'untrusted-host.example']) assert.ok(!response.body.includes(privateText), privateText);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer'); assert.match(String(response.headers['x-robots-tag']), /noindex/);
    assert.equal(writeCount(), writesBefore, 'Viewing metadata never creates sessions or extends owner retention');
    assert.equal(network.mock.calls.length, 0);
    assert.ok(response.body.includes('<script type="module" src="/assets/app.js"></script>'));
    assert.ok(response.body.includes('Enable JavaScript to open Dayriff and view this shared plan.'));
    assert.equal((response.body.match(/<title>/g) ?? []).length, 1);
    assert.equal((response.body.match(/property="og:title"/g) ?? []).length, 1);
    assert.equal((response.body.match(/name="description"/g) ?? []).length, 1);
    assert.equal((response.body.match(/rel="canonical"/g) ?? []).length, 1);
  } finally {await app.close();}
});

test('metadata escapes every title, description, image and alt attribute rather than adding executable markup', async () => {
  const plan = publicTrip(await fixture(), 'a'.repeat(43));
  plan.input.artist.name = 'Artist " onclick="bad() <script>alert(1)</script> & friends';
  plan.venue.city = 'City </title><img src=x onerror=bad()>';
  plan.stops[0]!.name = 'Place " data-injected="true <b>bold</b>';
  const metadata = sharedPageMetadata('https://dayriff.example', plan.id, plan);
  const html = renderSharedPage(template, {...metadata,
    image: 'https://images.example/photo.jpg?size=large&crop=wide" data-image-injected="true',
    imageAlt: 'Image " data-alt-injected="true <img src=x onerror=bad()> & caption'});
  assert.ok(!html.includes('<script>alert(1)</script>')); assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<b>bold</b>')); assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot; data-injected=&quot;true'));
  assert.ok(html.includes('photo.jpg?size=large&amp;crop=wide&quot; data-image-injected=&quot;true'));
  assert.ok(html.includes('Image &quot; data-alt-injected=&quot;true &lt;img src=x onerror=bad()&gt; &amp; caption'));
  assert.equal((html.match(/<script\b/g) ?? []).length, 1, 'Only the trusted application script remains');
});

test('shared plans always use the 1200×630 branded homepage screenshot regardless of provider photos', async () => {
  const plan = publicTrip(await fixture(), 'a'.repeat(43));
  const metadata = sharedPageMetadata('https://dayriff.example', plan.id, plan);
  assert.equal(metadata.image, 'https://dayriff.example/share-dayriff.jpg');
  assert.match(metadata.imageAlt, /close crop of the Dayriff homepage.*artist search/);
  const html = renderSharedPage(template, metadata);
  assert.ok(html.includes('property="og:image:width" content="1200"'));
  assert.ok(html.includes('property="og:image:height" content="630"'));
  assert.ok(html.includes('property="og:image:type" content="image/jpeg"'));
  plan.stops.forEach(stop => {delete stop.image;});
  delete plan.venue.image;
  assert.deepEqual(sharedPageMetadata('https://dayriff.example', plan.id, plan), metadata);
  assert.equal(sharedPageMetadata('https://dayriff.example', undefined).image, metadata.image);
});

test('expired, cleared, malformed and unknown share HTML is branded 404 without disclosing trip facts', async t => {
  let now = Date.UTC(2026, 9, 22, 12); t.mock.method(Date, 'now', () => now);
  const {app, link, plan, store, ownerId} = await pageApp();
  try {
    now += 7 * 86_400_000;
    for (const url of [link.path, '/shared/not-a-token', '/shared/' + 'a'.repeat(43), '/shared', '/shared/', '/shared/not-a-token/extra']) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 404, url);
      assert.ok(response.body.includes('Shared plan unavailable | Dayriff'));
      assert.ok(response.body.includes('https://dayriff.example/share-dayriff.jpg'));
      assert.ok(!response.body.includes(plan.input.artist.name)); assert.ok(!response.body.includes(plan.stops[0]!.name));
      assert.ok(!response.body.includes('first-place.jpg'));
      assert.equal(response.headers['cache-control'], 'no-store'); assert.match(String(response.headers['x-robots-tag']), /noindex/);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    now -= 7 * 86_400_000;
    await store.transact(`session:${ownerId}`, () => ({result: undefined}));
    const cleared = await app.inject(link.path);
    assert.equal(cleared.statusCode, 404); assert.ok(!cleared.body.includes(plan.stops[0]!.name));
  } finally {await app.close();}
});

test('public metadata origins cannot be poisoned through Host or forwarded host headers', () => {
  assert.equal(sharedPageOrigin(config, {headers: {host: 'evil.example', 'x-forwarded-host': 'other.example'}}), 'https://dayriff.example');
  const local = {...config, appOrigin: undefined};
  assert.equal(sharedPageOrigin(local, {headers: {host: '127.0.0.1:3004'}}), 'http://127.0.0.1:3004');
  for (const host of ['evil.example', 'localhost:99999', 'localhost@evil.example', 'localhost/evil', 'localhost:3000" onload="bad()']) assert.equal(sharedPageOrigin(local, {headers: {host}}), 'http://localhost:3000', host);
  assert.throws(() => sharedPageOrigin({...local, production: true}, {headers: {host: 'evil.example'}}), /APP_ORIGIN/);
});
