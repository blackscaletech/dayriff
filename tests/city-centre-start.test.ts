import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveStartingLocation} from '../src/server/providers/starting-location.js';
import type {ServerConfig} from '../src/server/config.js';
import {lookupStartingArea} from '../src/server/providers/geocoding.js';
import {ServiceError} from '../src/server/providers/http.js';
import type {Venue} from '../src/shared/types.js';

const venue: Venue = {id: '00000000-0000-4000-8000-000000000001', name: 'The Local Hall', city: 'Example City', address: '1 Main Street, Example City', coordinates: {latitude: 35.59, longitude: -82.55}, timezone: 'America/New_York', website: ''};
let sequence = 0;
function centralEntity(options: {city?: string; id?: string; latitude?: number; tag?: string; description?: string} = {}) {
  return {entity_id: options.id ?? venue.id, name: venue.name, types: ['urn:entity:place'], location: {lat: options.latitude ?? venue.coordinates.latitude, lon: venue.coordinates.longitude},
    properties: {address: venue.address, description: options.description, geocode: {city: options.city ?? venue.city}},
    tags: [{type: 'urn:tag:setting:qloo', value: options.tag ?? 'urn:tag:setting:qloo:city_center'}]};
}
async function withProvider(entity: unknown, run: (config: {qlooApiUrl: string; qlooApiKey: string}, paths: string[]) => Promise<void>) {
  const config = {qlooApiUrl: 'https://api.qloo.com', qlooApiKey: `city-centre-boundary-${++sequence}`};
  const original = globalThis.fetch, paths: string[] = [];
  globalThis.fetch = async resource => {
    const url = new URL(String(resource)); assert.equal(url.origin, config.qlooApiUrl); paths.push(url.pathname);
    if (url.pathname === '/entities') {
      assert.equal(url.searchParams.get('entity_ids'), venue.id);
      if (entity instanceof Response) return entity.clone();
      return new Response(JSON.stringify({results: [entity]}));
    }
    assert.equal(url.pathname, '/search'); return new Response(JSON.stringify({results: []}));
  };
  try {await run(config, paths);} finally {globalThis.fetch = original;}
}

test('generic downtown and city-centre starts explicitly identify a provider-verified central venue anchor', async () => {
  for (const query of ['Downtown', 'Downtown Example City', 'City centre', 'Town center']) await withProvider(centralEntity(), async (config, paths) => {
    const result = await lookupStartingArea(config, query, venue);
    assert.equal(result.status, 'found');
    if (result.status !== 'found') return;
    assert.equal(result.location.name, `${query.startsWith('Downtown') ? 'Downtown' : 'City centre'} Example City · The Local Hall`);
    assert.equal(result.location.approximate, true); assert.equal(result.location.source?.title, 'Qloo city-centre venue');
    assert.deepEqual(result.location.coordinates, venue.coordinates); assert.equal(result.location.id, venue.id);
    assert.equal(paths.filter(path => path === '/entities').length, 1); assert.equal(paths.length, 1);
  });
});

test('named neighborhoods and conflicting city requests never fall back to the concert venue', async () => {
  for (const query of ['SoHo', 'TriBeCa', 'Garden District', 'Downtown Other City']) await withProvider(centralEntity(), async (config, paths) => {
    assert.equal((await lookupStartingArea(config, query, venue)).status, 'not_found');
    assert.ok(!paths.includes('/entities'));
  });
  await withProvider(centralEntity(), async (config, paths) => {
    assert.equal((await lookupStartingArea(config, 'Downtown', venue, 'Other City')).status, 'not_found'); assert.ok(!paths.includes('/entities'));
  });
});

test('a central anchor requires exact selected identity, provider city and central setting evidence', async () => {
  for (const entity of [
    centralEntity({city: 'Other City'}), centralEntity({id: '00000000-0000-4000-8000-000000000002'}), centralEntity({latitude: 35.60}),
    centralEntity({tag: 'urn:tag:nearby_attraction:qloo:downtown_example_city', description: 'A downtown venue'}),
    centralEntity({tag: 'urn:tag:setting:qloo:edge_of_downtown', description: 'A downtown venue'}),
    {...centralEntity(), tags: [{type: 'urn:tag:setting:qloo', value: 'city_center', name: 'City center'}]},
    {...centralEntity(), properties: {address: venue.address}},
  ]) await withProvider(entity, async (config, paths) => {
    assert.equal((await lookupStartingArea(config, 'Downtown', venue)).status, 'not_found'); assert.equal(paths.filter(path => path === '/entities').length, 1);
  });
});

test('central-venue provider outages remain retryable instead of guessing a starting point', async () => {
  await withProvider(new Response('{}', {status: 503}), async (config, paths) => {
    assert.equal((await lookupStartingArea(config, 'Downtown', venue)).status, 'unavailable'); assert.equal(paths.filter(path => path === '/entities').length, 1);
  });
});

test('terminal quota and storage failures stop area lookup without a second paid request', async () => {
  for (const code of ['PROVIDER_DAILY_LIMIT', 'MAPS_DAILY_LIMIT', 'QUOTA_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'PLAN_TIMEOUT']) {
    const original = globalThis.fetch, requested: string[] = [];
    globalThis.fetch = async resource => {requested.push(new URL(String(resource)).pathname); throw new ServiceError('Terminal boundary', 503, code);};
    try {
      for (const query of ['Downtown', 'Named Quarter']) {
        requested.length = 0;
        await assert.rejects(lookupStartingArea({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: `terminal-centre-${++sequence}`}, query, venue), error => error instanceof ServiceError && error.code === code);
        assert.equal(requested.length, 1); assert.equal(requested[0], query === 'Downtown' ? '/entities' : '/search');
      }
    } finally {globalThis.fetch = original;}
  }
});

test('terminal interpretation and named-place failures preserve their code and stop further paid lookups', async () => {
  for (const code of ['PROVIDER_DAILY_LIMIT', 'QUOTA_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'PLAN_TIMEOUT']) {
    for (const failAtInterpretation of [true, false]) {
      const config: ServerConfig = {mode: 'live', production: false, port: 3000, host: '127.0.0.1', qlooApiUrl: 'https://api.qloo.com', qlooApiKey: `terminal-start-${++sequence}`, openaiApiKey: 'terminal-test-only', openaiModel: 'gpt-6-luna', openaiReasoningEffort: 'medium', cookieSecret: 'test-only', maxDailyPlans: 100, maxDailyLookups: 2000};
      const original = globalThis.fetch, requested: string[] = [];
      globalThis.fetch = async resource => {
        const url = new URL(String(resource)); requested.push(url.hostname);
        if (failAtInterpretation || url.hostname === 'api.qloo.com') throw new ServiceError('Terminal boundary', 503, code);
        return new Response(JSON.stringify({output: [{content: [{type: 'output_text', text: JSON.stringify({kind: 'place', query: 'Named Landmark', city: venue.city, clarification: null})}]}]}));
      };
      try {
        await assert.rejects(resolveStartingLocation(config, 'around Named Landmark', venue), error => error instanceof ServiceError && error.code === code);
        assert.deepEqual(requested, failAtInterpretation ? ['api.openai.com'] : ['api.openai.com', 'api.qloo.com']);
      } finally {globalThis.fetch = original;}
    }
  }
});
