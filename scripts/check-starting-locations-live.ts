/** Opt-in real-provider regression: adjacent municipality starts must retain provider geography. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {createApp} from '../src/server/app.js';
import {loadConfig} from '../src/server/config.js';
import {distanceMeters} from '../src/server/providers/walking.js';
import type {Artist, PlanResponse, VenueSearchResult} from '../src/shared/types.js';
if (!process.argv.includes('--live')) throw new Error('This check makes paid provider calls. Supply --live explicitly.');
const config = {...loadConfig(), storageBackend: 'memory' as const};
assert.equal(config.mode, 'live');
const app = await createApp(config);
app.log.level = 'silent';
const providerCalls: Record<string, number> = {};
const originalFetch = globalThis.fetch;
let callCount = 0;
globalThis.fetch = async (resource, init) => {
  const url = new URL(resource instanceof Request ? resource.url : String(resource));
  assert.ok(++callCount <= 12, 'Bounded check exceeded 12 provider requests');
  providerCalls[`${url.hostname}${url.pathname}`] = (providerCalls[`${url.hostname}${url.pathname}`] ?? 0) + 1;
  return originalFetch(resource, init);
};
let cookie = '';
async function api<T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({method, url, payload: payload as object | undefined, headers: {'x-dayriff-request': '1', ...(cookie ? {cookie} : {})}});
  if (response.cookies.length) cookie = response.cookies.map(item => `${item.name}=${encodeURIComponent(item.value)}`).join('; ');
  assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
  return response.json<T>();
}
const runId = new Date().toISOString().replaceAll(':', '-');
const report: Record<string, unknown> = {runId, providerCalls, checks: []};
try {
  const venues = (await api<VenueSearchResult>('GET', '/api/venues?q=Hollywood%20Bowl')).venues;
  const venue = venues.find(item => item.name === 'Hollywood Bowl' && item.city === 'Los Angeles' && item.coordinates.latitude > 34 && item.coordinates.latitude < 34.2 && item.coordinates.longitude > -118.5 && item.coordinates.longitude < -118.2);
  assert.ok(venue, 'Qloo must verify the Los Angeles Hollywood Bowl');
  const artists = (await api<{artists: Artist[]}>('GET', '/api/artists?q=The%20Rolling%20Stones')).artists;
  const artist = artists.find(item => item.name === 'The Rolling Stones'); assert.ok(artist);
  const response = await api<PlanResponse>('POST', '/api/plans', {artist, venueId: venue.id, date: '2026-10-24', showTime: '19:00', durationMinutes: 300, startingPoint: 'beverly hills'});
  const plan = response.itinerary;
  assert.equal(plan.mode, 'live'); assert.equal(plan.venue.id, venue.id);
  assert.equal(plan.startingLocation?.id, 'b0229426-8b83-434a-9243-785b9430e31d');
  assert.equal(plan.startingLocation.name, 'Beverly Hills'); assert.equal(plan.startingLocation.approximate, true);
  assert.deepEqual(plan.startingLocation.coordinates, {latitude: 34.078530378534744, longitude: -118.40214505107477});
  const distance = Math.round(distanceMeters(venue.coordinates, plan.startingLocation.coordinates)); assert.ok(distance < 8000);
  assert.ok(plan.stops.length >= 1); assert.ok(plan.totalMinutes <= 300);
  assert.equal(plan.input.budget, undefined); assert.equal(plan.input.arrivalBy, undefined);
  const restored = await api<{itinerary: typeof plan}>('GET', '/api/session'); assert.deepEqual(restored.itinerary, plan);
  Object.assign(report, {passed: true, checks: ['Real Hollywood Bowl and artist identity', 'Unqualified lowercase municipality interpreted correctly', 'Original Qloo municipality coordinates, marked approximate', 'Unchanged 8km straight-line boundary', 'Feasible real-provider route and correctly absent optional preferences', 'Owned isolated session reload'], straightLineMeters: distance, message: response.message,
    plan: {id: plan.id, venue: plan.venue, startingLocation: plan.startingLocation, stops: plan.stops.map(({id, name, category, coordinates}) => ({id, name, category, coordinates})), totalMinutes: plan.totalMinutes, walkingMinutes: plan.totalWalkMinutes}});
  console.log(JSON.stringify(report));
} catch (error) {
  report.passed = false; report.error = error instanceof Error ? error.message : String(error); console.log(JSON.stringify(report)); process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await mkdir('.private/starting-live-qa', {recursive: true});
  await writeFile(`.private/starting-live-qa/${runId}.json`, JSON.stringify(report, null, 2));
  await app.close();
}
