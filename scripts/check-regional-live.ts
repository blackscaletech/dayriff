/** Manual, opt-in real-provider acceptance checks beyond New York and London. */
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';
import {loadConfig} from '../src/server/config.js';
import {derivePlanningWindow, clockTime, dateAtMinutes} from '../src/shared/planning-window.js';
import type {Artist, Itinerary, PlanResponse, Venue, VenueSearchResult} from '../src/shared/types.js';

if (!process.argv.includes('--live')) throw new Error('This manual check makes real, paid provider calls. Supply --live explicitly.');
const config = {...loadConfig(), storageBackend: 'memory' as const};
assert.equal(config.mode, 'live', 'Regional checks require configured live mode.');
const app = await createApp(config);
app.log.level = 'silent';
const directory = '.private/regional-live-qa';
await mkdir(directory, {recursive: true});
const runId = new Date().toISOString().replaceAll(':', '-');
const providerCalls: Record<string, {calls: number; errors: number}> = {};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const counter = providerCalls[`${url.hostname}${url.pathname}`] ??= {calls: 0, errors: 0};
  counter.calls++;
  try {const response = await originalFetch(input, init); if (!response.ok) counter.errors++; return response;}
  catch (error) {counter.errors++; throw error;}
};
interface Event {action: string; elapsedMs: number; checks: string[]; errors: string[]; message?: string; plan?: unknown}
interface Scenario {name: string; city: string; query: string; latitude: [number, number]; longitude: [number, number]; duration: number; venue?: Venue; discoveries?: Venue[]; events: Event[]; failures: string[]}
const regionalScenarios: Scenario[] = [
  {name: 'asheville', city: 'Asheville', query: 'The Orange Peel', latitude: [35.50, 35.70], longitude: [-82.7, -82.4], duration: 360, events: [], failures: []},
  {name: 'ghent', city: 'Ghent', query: 'De Bijloke', latitude: [50.95, 51.15], longitude: [3.60, 3.85], duration: 360, events: [], failures: []},
  {name: 'tulsa', city: 'Tulsa', query: "Cain's Ballroom", latitude: [36.05, 36.25], longitude: [-96.10, -95.85], duration: 360, events: [], failures: []},
  {name: 'dunedin', city: 'Dunedin', query: 'Dunedin Town Hall', latitude: [-45.95, -45.80], longitude: [170.40, 170.65], duration: 360, events: [], failures: []},
];
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const customStart = process.argv.find(arg => arg.startsWith('--start='))?.slice(8);
const scenarios = regionalScenarios.filter(scenario => selected ? scenario.name === selected : scenario.name !== 'ghent');
const discoveredFile = `${directory}/verified-venues.json`;
let verified: Record<string, Venue> = {};
try {verified = JSON.parse(await readFile(discoveredFile, 'utf8')) as Record<string, Venue>;} catch {}
async function save() {await writeFile(`${directory}/${runId}.json`, JSON.stringify({runId, providerCalls, scenarios}, null, 2));}
function safeSummary(plan: Itinerary) {return {id: plan.id, revision: plan.revision, input: plan.input, venue: plan.venue, startingLocation: plan.startingLocation, totalMinutes: plan.totalMinutes, walkingMinutes: plan.totalWalkMinutes, estimatedArrival: plan.estimatedArrival, routeUrl: plan.routeUrl, notices: plan.notices,
  stops: plan.stops.map(({id, name, category, coordinates, address, costTier, arrivalTime, durationMinutes}) => ({id, name, category, coordinates, address, costTier, arrivalTime, durationMinutes}))};}
function distanceKm(a: Venue['coordinates'], b: Venue['coordinates']) {
  const toRad = (n: number) => n * Math.PI / 180;
  const latitude = toRad(b.latitude - a.latitude), longitude = toRad(b.longitude - a.longitude);
  const half = Math.sin(latitude / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(half), Math.sqrt(1 - half));
}
function inCity(venue: Venue, scenario: Scenario) {
  const cityNames = scenario.city === 'Ghent' ? ['ghent', 'gent'] : [scenario.city.toLowerCase()];
  return cityNames.includes(venue.city.toLowerCase().trim()) && venue.coordinates.latitude >= scenario.latitude[0] && venue.coordinates.latitude <= scenario.latitude[1] && venue.coordinates.longitude >= scenario.longitude[0] && venue.coordinates.longitude <= scenario.longitude[1];
}
function invariant(plan: Itinerary, scenario: Scenario) {
  assert.equal(plan.mode, 'live'); assert.ok(inCity(plan.venue, scenario), 'Verified venue must remain inside the intended structured city and geography');
  assert.ok(plan.stops.length >= 1 && plan.stops.length <= 3); assert.equal(new Set(plan.stops.map(stop => stop.id)).size, plan.stops.length);
  assert.ok(plan.stops.every(stop => distanceKm(stop.coordinates, plan.venue.coordinates) <= 12), 'Stops must remain within local walking geography');
  assert.equal(plan.totalMinutes, plan.totalWalkMinutes + plan.stops.reduce((sum, stop) => sum + stop.durationMinutes, 0)); assert.ok(plan.totalMinutes <= plan.input.durationMinutes);
  let clock = derivePlanningWindow(plan.input).startMinutes;
  for (const stop of plan.stops) {
    assert.ok(!/^(?:starbucks|mcdonald.?s)(?:$|\b)/i.test(stop.name), 'Obvious generic chains must not become cultural suggestions');
    clock += stop.walkMinutes; assert.equal(stop.arrivalTime, clockTime(clock)); assert.equal(stop.arrivalDate, dateAtMinutes(plan.input.date, clock));
    clock += stop.durationMinutes; assert.equal(stop.departureTime, clockTime(clock));
    if (plan.input.budget === 'low' || plan.input.budget === 'medium') assert.ok(stop.costTier && stop.costTier <= (plan.input.budget === 'low' ? 1 : 2), 'Budget filters require known prices');
  }
  clock += plan.totalWalkMinutes - plan.stops.reduce((sum, stop) => sum + stop.walkMinutes, 0);
  assert.equal(plan.estimatedArrival, clockTime(clock)); assert.equal(plan.estimatedArrivalDate, dateAtMinutes(plan.input.date, clock));
  const route = new URL(plan.routeUrl); assert.equal(route.hostname, 'www.google.com'); assert.equal(route.searchParams.get('travelmode'), 'walking');
  const locationText = (value: string) => value.replace(/[\u0000-\u001f|]/g, ' ').replace(/\s+/g, ' ').trim();
  const expectedMapValue = (point: Itinerary['venue'] | Itinerary['stops'][number]) => [...new Set([locationText(point.name), locationText(point.address), locationText(plan.venue.city)].filter(Boolean))].join(', ');
  const coordinateValue = (point: Itinerary['venue'] | Itinerary['stops'][number]) => `${point.coordinates.latitude},${point.coordinates.longitude}`;
  assert.ok([expectedMapValue(plan.venue), coordinateValue(plan.venue)].includes(route.searchParams.get('destination') ?? ''), 'Maps must use the exact verified venue name/address/city or coordinates');
  const waypoints = route.searchParams.get('waypoints')?.split('|');
  assert.equal(waypoints?.length, plan.stops.length);
  plan.stops.forEach((stop, index) => assert.ok([expectedMapValue(stop), coordinateValue(stop)].includes(waypoints![index]!), 'Every Maps waypoint must match the verified stop in route order'));
  if (plan.venue.googlePlaceId) assert.equal(route.searchParams.get('destination_place_id'), plan.venue.googlePlaceId);
}
const ids = (plan: Itinerary) => plan.stops.map(stop => stop.id);
async function run(scenario: Scenario, index: number) {
  let cookie = ''; let plan: Itinerary | undefined;
  const api = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<T> => {
    const request = () => app.inject({method, url, payload: payload as object | undefined, remoteAddress: `127.0.1.${index + 10}`, headers: {'x-dayriff-request': '1', ...(cookie ? {cookie} : {})}});
    let response = await request();
    if (response.statusCode === 429 && response.json().code === 'RATE_LIMITED') {await pause(Math.min(60, Math.max(1, Number(response.headers['retry-after']) || 60)) * 1000); response = await request();}
    if (response.cookies.length) cookie = response.cookies.map(item => `${item.name}=${encodeURIComponent(item.value)}`).join('; ');
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`); return response.json<T>();
  };
  const check = async (action: string, task: (event: Event) => Promise<void>) => {
    const event: Event = {action, elapsedMs: 0, checks: [], errors: []}; const began = performance.now();
    try {await task(event);} catch (error) {const text = error instanceof Error ? error.message : String(error); event.errors.push(text); scenario.failures.push(`${action}: ${text}`);}
    event.elapsedMs = Math.round(performance.now() - began); if (plan) event.plan = safeSummary(plan); scenario.events.push(event);
    console.log(JSON.stringify({scenario: scenario.name, action, seconds: event.elapsedMs / 1000, passed: !event.errors.length, message: event.message, places: plan?.stops.map(stop => `${stop.name} (${stop.category})`), errors: event.errors})); await save();
  };
  await check('discover verified live venue', async event => {
    const result = await api<VenueSearchResult>('GET', `/api/venues?q=${encodeURIComponent(scenario.query)}`);
    scenario.discoveries = result.venues;
    scenario.venue = result.venues.find(item => inCity(item, scenario));
    assert.ok(scenario.venue, `No verified live venue in ${scenario.city}; candidates: ${result.venues.map(item => `${item.name} (${item.city})`).join(', ')}`);
    verified[scenario.name] = scenario.venue;
    event.message = `${scenario.venue.name} · ${scenario.venue.city} · ${scenario.venue.coordinates.latitude},${scenario.venue.coordinates.longitude}`;
    event.checks.push('Venue returned by Qloo with matching structured city and bounded real coordinates');
    await writeFile(discoveredFile, JSON.stringify(verified, null, 2));
  });
  if (process.argv.includes('--discover') || !scenario.venue) return;
  await check('initial real-provider plan', async event => {
    const artists = (await api<{artists: Artist[]}>('GET', '/api/artists?q=Khruangbin')).artists;
    const artist = artists.find(item => item.name.toLowerCase() === 'khruangbin'); assert.ok(artist, 'Live artist ID must be returned by Qloo');
    const result = await api<PlanResponse>('POST', '/api/plans', {artist, venueId: scenario.venue!.id, date: '2026-10-24', showTime: '20:00', durationMinutes: scenario.duration, startingPoint: customStart ?? 'Near the venue'});
    plan = result.itinerary; event.message = result.message; invariant(plan, scenario);
    if (customStart && !/^(?:nearby|near the venue|at the venue)$/i.test(customStart.trim())) assert.ok(plan.startingLocation, 'A named starting area must be resolved explicitly rather than silently becoming Near the venue');
    if (plan.startingLocation?.source?.title === 'Qloo city-centre venue') {assert.ok(plan.startingLocation.name.includes(plan.venue.name)); assert.ok(plan.startingLocation.name.includes(plan.venue.city)); assert.equal(plan.startingLocation.approximate, true); assert.ok(distanceKm(plan.startingLocation.coordinates, plan.venue.coordinates) <= 0.15);}
    assert.equal(plan.input.budget, undefined); assert.equal(plan.input.arrivalBy, undefined); event.checks.push('Real place coverage, correct geography, schedule, map identity, absent optional filters');
  });
  if (!plan || process.argv.includes('--initial-only')) return;
  const revise = async (message: string, event: Event, verify: (before: Itinerary, after: Itinerary, response: PlanResponse) => void, extra: object = {}) => {
    const before = structuredClone(plan!); const result = await api<PlanResponse>('POST', `/api/plans/${before.id}/revise`, {message, ...extra});
    plan = result.itinerary; event.message = result.message; invariant(plan, scenario); assert.equal(plan.id, before.id); assert.equal(plan.venue.id, before.venue.id); assert.equal(plan.input.artist.id, before.input.artist.id); verify(before, plan, result); event.checks.push('Full route and saved inputs verified against assistant response');
  };
  await check('two stops then add one', async event => {
    await revise('Keep exactly two stops for now.', event, (_before, after, response) => {assert.equal(after.stops.length, 2, response.message);});
    await revise('Add another stop.', event, (before, after, response) => {assert.equal(after.stops.length, 3, response.message); assert.ok(after.stops.some(stop => !ids(before).includes(stop.id)));});
  });
  await check('atomic targeted swap', async event => {
    const target = plan!.stops[0]!;
    await revise(`Find a different alternative to ${target.name}. Keep every other stop exactly as it is.`, event, (before, after, response) => {
      if (ids(after).join('|') === ids(before).join('|')) {assert.deepEqual(after, before); assert.match(response.message ?? '', /could not|cannot|couldn't|available|fit|different/i); event.checks.push('Sparse alternatives truthfully guarded without corrupting route');}
      else {assert.equal(after.stops.length, before.stops.length); assert.ok(!ids(before).includes(after.stops[0]!.id)); assert.deepEqual(ids(after).slice(1), ids(before).slice(1));}
    }, {replaceStopId: target.id});
  });
  await check('change cultural preference', event => revise('More culture, with three stops total.', event, (before, after, response) => {
    assert.equal(after.stops.length, 3);
    if (ids(before).join('|') === ids(after).join('|')) {assert.deepEqual(after, before); assert.match(response.message ?? '', /could not|cannot|couldn't|culture|cultural|available|fit/i); event.checks.push('Limited cultural coverage guarded without inventing places');}
    else assert.ok(after.stops.filter(stop => stop.category === 'culture').length >= Math.min(3, before.stops.filter(stop => stop.category === 'culture').length + 1));
  }));
  await check('over-capacity recovery', event => revise('Add two more stops to this three-stop plan.', event, (before, after, response) => {assert.deepEqual(after, before); assert.match(response.message ?? '', /three|3/); assert.match(response.message ?? '', /limit|maximum|supports|up to/i);}));
  await check('read-only explanation', event => revise('Why did you pick these places? Do not change my plan.', event, (before, after, response) => {assert.deepEqual(after, before); assert.ok(response.message && response.message.length > 25); assert.doesNotMatch(response.message, /could not fit|could not find a different outing/i);}));
  await check('cookie session reload', async event => {const result = await api<{itinerary: Itinerary; messages: {role: string; text: string}[]}>('GET', '/api/session'); assert.deepEqual(result.itinerary, plan); assert.ok(result.messages.length >= 7); assert.equal(result.messages.at(-2)?.text, 'Why did you pick these places? Do not change my plan.'); event.checks.push('Plan and actual multi-turn conversation persisted in owned cookie session');});
}
try {for (const [index, scenario] of scenarios.entries()) await run(scenario, index); await save(); console.log(JSON.stringify({report: `${directory}/${runId}.json`, scenarios: scenarios.length, checks: scenarios.reduce((sum, scenario) => sum + scenario.events.length, 0), failures: scenarios.reduce((sum, scenario) => sum + scenario.failures.length, 0), providerCalls})); if (scenarios.some(scenario => scenario.failures.length)) process.exitCode = 1;}
finally {globalThis.fetch = originalFetch; await app.close();}
