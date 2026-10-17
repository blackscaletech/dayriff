/** Opt-in live acceptance check. Uses real providers and isolated synthetic user sessions. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {createApp} from '../src/server/app.js';
import {loadConfig} from '../src/server/config.js';
import {derivePlanningWindow, clockTime, dateAtMinutes} from '../src/shared/planning-window.js';
import type {Artist, Itinerary, PlanHistoryEntry, PlanResponse, Venue} from '../src/shared/types.js';

if (!process.argv.includes('--live')) throw new Error('This check makes paid live API calls. Run with --live deliberately.');
const config = {...loadConfig(), storageBackend: 'memory' as const};
assert.equal(config.mode, 'live', 'Configure APP_MODE=live before this opt-in check.');
const app = await createApp(config);
app.log.level = 'silent';
const outDir = '.private/live-qa';
await mkdir(outDir, {recursive: true});
const runId = new Date().toISOString().replaceAll(':', '-');
const providerCalls: Record<string, {calls: number; errors: number}> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const key = `${url.hostname}${url.pathname}`;
  const counter = providerCalls[key] ??= {calls: 0, errors: 0};
  counter.calls++;
  try {const response = await realFetch(input, init); if (!response.ok) counter.errors++; return response;}
  catch (error) {counter.errors++; throw error;}
};
interface Event {action: string; elapsedMs: number; checks: string[]; errors: string[]; message?: string; plan?: unknown}
interface Scenario {name: string; artist: string; venue: string; city: 'New York' | 'London'; start: string; budget?: 'low'; duration: number; events: Event[]; failures: string[]; rateLimitWaits?: number}
const scenarios: Scenario[] = [
  {name: 'nyc-soho', artist: 'The Rolling Stones', venue: 'Madison Square Garden', city: 'New York', start: 'aeround soho area', budget: 'low', duration: 360, events: [], failures: []},
  {name: 'nyc-near-venue', artist: 'Khruangbin', venue: 'Bowery Ballroom', city: 'New York', start: 'Near the venue', duration: 300, events: [], failures: []},
  {name: 'london', artist: 'Radiohead', venue: 'Roundhouse', city: 'London', start: 'around Camden Town', duration: 360, events: [], failures: []},
].filter(scenario => !process.argv.find(arg => arg.startsWith('--case=')) || scenario.name === process.argv.find(arg => arg.startsWith('--case='))!.slice(7)) as Scenario[];
async function save() {await writeFile(`${outDir}/${runId}.json`, JSON.stringify({runId, providerCalls, scenarios}, null, 2));}
function summary(plan: Itinerary) {return {revision: plan.revision, input: plan.input, venue: plan.venue.name, startingLocation: plan.startingLocation?.name,
  totalMinutes: plan.totalMinutes, walkingMinutes: plan.totalWalkMinutes, estimatedArrival: plan.estimatedArrival,
  stops: plan.stops.map(({id, name, category, costTier, arrivalTime, durationMinutes}) => ({id, name, category, costTier, arrivalTime, durationMinutes}))};}
function invariant(plan: Itinerary) {
  assert.equal(plan.mode, 'live');
  assert.ok(plan.stops.length >= 1 && plan.stops.length <= 3);
  assert.equal(new Set(plan.stops.map(stop => stop.id)).size, plan.stops.length);
  assert.ok(plan.totalMinutes <= plan.input.durationMinutes);
  assert.equal(plan.totalMinutes, plan.totalWalkMinutes + plan.stops.reduce((sum, stop) => sum + stop.durationMinutes, 0));
  let clock = derivePlanningWindow(plan.input).startMinutes;
  for (const stop of plan.stops) {
    clock += stop.walkMinutes;
    assert.equal(stop.arrivalTime, clockTime(clock));
    assert.equal(stop.arrivalDate, dateAtMinutes(plan.input.date, clock));
    clock += stop.durationMinutes;
    assert.equal(stop.departureTime, clockTime(clock));
    if (plan.input.budget === 'low' || plan.input.budget === 'medium') assert.ok(stop.costTier && stop.costTier <= (plan.input.budget === 'low' ? 1 : 2), 'Budget must be verified on every stop');
  }
  const finalWalk = plan.totalWalkMinutes - plan.stops.reduce((sum, stop) => sum + stop.walkMinutes, 0);
  assert.ok(finalWalk >= 0);
  clock += finalWalk;
  assert.equal(plan.estimatedArrival, clockTime(clock));
  assert.equal(plan.estimatedArrivalDate, dateAtMinutes(plan.input.date, clock));
  const map = new URL(plan.routeUrl);
  assert.equal(map.hostname, 'www.google.com');
  assert.equal(map.searchParams.get('travelmode'), 'walking');
  const waypoints = map.searchParams.get('waypoints')?.split('|');
  assert.equal(waypoints?.length, plan.stops.length);
  const destination = map.searchParams.get('destination') ?? '';
  const venuePoint = `${plan.venue.coordinates.latitude},${plan.venue.coordinates.longitude}`;
  assert.ok(destination === venuePoint || destination.includes(plan.venue.name), 'Directions must end at the verified concert venue');
  plan.stops.forEach((stop, index) => {
    const point = `${stop.coordinates.latitude},${stop.coordinates.longitude}`;
    assert.ok(waypoints![index] === point || waypoints![index]!.includes(stop.name), 'Map stops must match the itinerary order');
    assert.ok(!/^(?:starbucks|mcdonald.?s)(?:$|\b)/i.test(stop.name), 'Generic chains must not become cultural recommendations');
  });
}
const ids = (plan: Itinerary) => plan.stops.map(stop => stop.id);
const added = (before: Itinerary, after: Itinerary) => after.stops.filter(stop => !ids(before).includes(stop.id));
async function run(scenario: Scenario, index: number) {
  let cookie = '';
  let plan: Itinerary;
  const api = async <T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown): Promise<T> => {
    const request = () => app.inject({method, url, payload: payload as object | undefined, remoteAddress: `127.0.0.${index + 2}`,
      headers: {'x-dayriff-request': '1', ...(cookie ? {cookie} : {})}});
    let response = await request();
    if (response.statusCode === 429 && response.json().code === 'RATE_LIMITED') {
      const seconds = Math.min(60, Math.max(1, Number(response.headers['retry-after']) || 60));
      scenario.rateLimitWaits = (scenario.rateLimitWaits ?? 0) + 1;
      console.log(JSON.stringify({scenario: scenario.name, action: 'honor app rate limit', seconds}));
      await pause(seconds * 1000);
      response = await request();
    }
    if (response.cookies.length) cookie = response.cookies.map(item => `${item.name}=${encodeURIComponent(item.value)}`).join('; ');
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    return response.json<T>();
  };
  const check = async (action: string, task: (event: Event) => Promise<void>) => {
    const event: Event = {action, elapsedMs: 0, checks: [], errors: []};
    const start = performance.now();
    try {await task(event);} catch (error) {const text = error instanceof Error ? error.message : String(error); event.errors.push(text); scenario.failures.push(`${action}: ${text}`);}
    event.elapsedMs = Math.round(performance.now() - start);
    if (plan) event.plan = summary(plan);
    scenario.events.push(event);
    console.log(JSON.stringify({scenario: scenario.name, action, seconds: event.elapsedMs / 1000, passed: !event.errors.length, message: event.message, stops: plan?.stops.map(stop => `${stop.name} (${stop.category})`), errors: event.errors}));
    await save();
  };
  const revise = async (message: string, event: Event, verify: (previous: Itinerary, current: Itinerary, result: PlanResponse) => void, extra: object = {}) => {
    const previous = structuredClone(plan);
    const result = await api<PlanResponse>('POST', `/api/plans/${plan.id}/revise`, {message, ...extra});
    plan = result.itinerary;
    event.message = result.message;
    invariant(plan);
    assert.equal(plan.id, previous.id);
    assert.equal(plan.venue.id, previous.venue.id);
    assert.equal(plan.input.artist.id, previous.input.artist.id);
    assert.equal(plan.input.startingPoint, previous.input.startingPoint);
    verify(previous, plan, result);
    event.checks.push('Route, timing, budget, identity and operation checks passed');
  };
  await check('initial live plan', async event => {
    const artists = (await api<{artists: Artist[]}>('GET', `/api/artists?q=${encodeURIComponent(scenario.artist)}`)).artists;
    const artist = artists.find(item => item.name.toLowerCase() === scenario.artist.toLowerCase());
    assert.ok(artist, 'Exact artist must appear in live search');
    const venues = (await api<{venues: Venue[]}>('GET', `/api/venues?q=${encodeURIComponent(scenario.venue)}`)).venues;
    const normalizedName = (name: string) => name.toLowerCase().replace(/^the /, '').trim();
    const venue = venues.find(item => normalizedName(item.name) === normalizedName(scenario.venue) && (scenario.city === 'London' ? item.coordinates.latitude > 51 && item.coordinates.latitude < 52 : item.coordinates.latitude > 40 && item.coordinates.latitude < 41));
    assert.ok(venue, `Live venue search must resolve ${scenario.venue} in ${scenario.city}; returned ${venues.map(item => item.name).join(", ")}`);
    const result = await api<PlanResponse>('POST', '/api/plans', {artist, venueId: venue.id, date: '2026-10-22', showTime: '19:00', durationMinutes: scenario.duration, startingPoint: scenario.start, ...(scenario.budget ? {budget: scenario.budget} : {})});
    plan = result.itinerary; event.message = result.message; invariant(plan);
    assert.equal(plan.input.budget, scenario.budget);
    assert.equal(plan.input.arrivalBy, undefined);
    event.checks.push('Real search IDs, real recommendations, schedule and optional-input preservation');
  });
  if (!plan!) return;
  await check('make two stops', event => revise('Let’s keep this to exactly two stops for now.', event, (_before, after) => {assert.equal(after.stops.length, 2);}));
  await check('add another stop', event => revise('Add another stop.', event, (before, after) => {assert.equal(before.stops.length, 2); assert.equal(after.stops.length, 3); assert.ok(added(before, after).length >= 1);}));
  await check('more culture', event => revise('More culture', event, (before, after, result) => {
    assert.equal(after.stops.length, 3);
    if (scenario.budget && !added(before, after).length) {
      assert.deepEqual(after, before);
      assert.match(result.message ?? '', /verified price tier/);
      event.checks.push('Correctly preserved a verified-price constraint; cultural prices are unavailable, rather than inventing admission costs');
    } else {assert.ok(added(before, after).length >= 1); assert.ok(after.stops.filter(stop => stop.category === 'culture').length >= Math.min(3, before.stops.filter(stop => stop.category === 'culture').length + 1));}
  }));
  if (scenario.budget) await check('remove budget and rebalance', event => revise('Remove the budget preference and give me more culture.', event, (before, after) => {assert.equal(after.input.budget, undefined); assert.equal(after.stops.length, 3); assert.ok(added(before, after).length >= 1); assert.ok(after.stops.filter(stop => stop.category === 'culture').length >= Math.min(3, before.stops.filter(stop => stop.category === 'culture').length + 1));}));
  if (scenario.name === 'nyc-near-venue') await check('more culture again', event => revise('More culture please, something I have not seen yet.', event, (before, after) => {assert.equal(after.stops.length, 3); assert.ok(added(before, after).length >= 1);}));
  await check('swap a single stop', event => {const target = plan.stops[1] ?? plan.stops[0]!; return revise(`Find an alternative to ${target.name}`, event, (before, after) => {assert.equal(after.stops.length, before.stops.length); const slot = before.stops.findIndex(stop => stop.id === target.id); assert.ok(!ids(before).includes(after.stops[slot]!.id)); before.stops.forEach((stop, position) => {if (position !== slot) assert.equal(after.stops[position]!.id, stop.id);}); assert.deepEqual(after.input, before.input);}, {replaceStopId: target.id});});
  await check('typed atomic swap', event => revise('Swap the first stop for a different place. Keep the other two stops exactly as they are.', event, (before, after) => {assert.equal(after.stops.length, 3); assert.ok(!ids(before).includes(after.stops[0]!.id)); assert.deepEqual(ids(after).slice(1), ids(before).slice(1)); assert.deepEqual(after.input, before.input);}));
  await check('change budget and add bookstore', event => revise('Remove the budget preference. Keep three stops, with at least one bookstore.', event, (_before, after) => {assert.equal(after.input.budget, undefined); assert.equal(after.stops.length, 3); assert.ok(after.stops.some(stop => /book.?store|book.?shop/i.test(`${stop.name} ${stop.description} ${stop.taxonomy?.join(' ')}`)));}));
  const beforeArrival = structuredClone(plan);
  await check('change arrival time', event => revise('Get me to the venue by 6:15 pm. Keep the same exploration duration.', event, (before, after) => {assert.equal(after.input.arrivalBy, '18:15'); assert.equal(after.input.showTime, '19:00'); assert.equal(after.input.durationMinutes, before.input.durationMinutes); assert.equal(after.input.budget, undefined); assert.equal(after.stops.length, 3);}));
  await check('restore earlier plan', async event => {
    const session = await api<{history: PlanHistoryEntry[]}>('GET', '/api/session');
    const version = session.history.find(entry => entry.stops.map(stop => stop.id).join('|') === ids(beforeArrival).join('|') && entry.schedule.arrivalBy === beforeArrival.input.arrivalBy);
    assert.ok(version, 'The prior complete plan must be available in owned history');
    const result = await api<PlanResponse>('POST', `/api/plans/${plan.id}/restore`, {versionId: version.id});
    plan = result.itinerary; event.message = result.message; invariant(plan);
    assert.deepEqual(plan.input, beforeArrival.input); assert.deepEqual(ids(plan), ids(beforeArrival));
    event.checks.push('Owned history restores route and optional preferences together');
  });
  if (process.argv.includes('--edges')) {
    const isBookstore = (stop: Itinerary['stops'][number]) => stop.category === 'shop' && /book.?store|book.?shop/i.test(`${stop.name} ${stop.description} ${stop.taxonomy?.join(' ')}`);
    if (scenario.name === 'nyc-soho') {
      await check('avoid bookstores and change taste', event => revise('No bookstores now. Replace that requirement with one outdoor stop and keep exactly three stops total.', event, (_before, after) => {
        assert.equal(after.stops.length, 3); assert.ok(!after.stops.some(isBookstore)); assert.ok(after.stops.some(stop => stop.category === 'outdoors'));
      }));
      await check('avoidance survives fresh alternatives', event => revise('A completely different three-stop plan, still no bookstores.', event, (before, after) => {
        assert.equal(after.stops.length, 3); assert.equal(added(before, after).length, 3); assert.ok(!after.stops.some(isBookstore));
      }));
      await check('withdraw avoidance for targeted replacement', event => revise('Bookstores are okay again. Remove the outdoor-stop requirement too. Swap the first stop for a bookstore and keep the other two exactly as they are.', event, (before, after) => {
        assert.equal(after.stops.length, 3); assert.ok(isBookstore(after.stops[0]!)); assert.ok(!ids(before).includes(after.stops[0]!.id)); assert.deepEqual(ids(after).slice(1), ids(before).slice(1));
      }));
    } else if (scenario.name === 'nyc-near-venue') {
      await check('replacement kind and whole-plan culture together', event => {
        const target = plan.stops.find(isBookstore); assert.ok(target, 'A bookstore must be available to replace');
        return revise(`Drop the bookstore requirement. Replace ${target.name} with a café. Keep the other two stops and at least two cultural stops, with exactly three stops total.`, event, (before, after) => {
          const slot = before.stops.findIndex(stop => stop.id === target.id); assert.equal(after.stops[slot]!.category, 'food');
          assert.equal(after.stops.filter(stop => stop.category === 'culture').length, 2);
          before.stops.forEach((stop, position) => {if (position !== slot) assert.equal(after.stops[position]!.id, stop.id);});
        });
      });
      await check('contradictory exclusive request is atomic', event => revise('Only cafés now, but keep both cultural stops too.', event, (before, after, result) => {
        assert.deepEqual(after, before); assert.ok(result.message && result.message.length > 20);
      }));
      await check('negated mutation plus factual question', event => revise('Do not make it cheaper or change anything. Is budget filtering currently on?', event, (before, after, result) => {
        assert.deepEqual(after, before); assert.ok(result.message && result.message.length > 20);
      }));
    } else {
      await check('arrival after show is rejected without mutation', event => revise('Get me to the venue by 8 pm.', event, (before, after, result) => {
        assert.deepEqual(after, before); assert.match(result.message ?? '', /before|show|arrival/i);
      }));
      await check('unsupported city change leaves verified venue intact', event => revise('Move this trip to New York instead.', event, (before, after, result) => {
        assert.deepEqual(after, before); assert.match(result.message ?? '', /form|edit|venue|city|New York/i);
      }));
      await check('avoid an absent kind without changing good stops', event => revise('No food or drink stops, but keep these three places.', event, (before, after) => {
        assert.deepEqual(after.stops, before.stops); assert.deepEqual(after.input, before.input); assert.ok(after.stops.every(stop => stop.category !== 'food'));
      }));
    }
  }
  if (process.argv.includes('--comfort')) {
    await check('reduce walking without losing stops', event => revise('Less walking please. Keep exactly three stops.', event, (before, after, result) => {
      assert.equal(after.stops.length, 3);
      if (after.totalWalkMinutes < before.totalWalkMinutes) assert.ok(added(before, after).length > 0 || ids(after).join('|') !== ids(before).join('|'));
      else {assert.deepEqual(after, before); assert.match(result.message ?? '', /walk|shorter|fit/i); event.checks.push('No fabricated walking reduction when no feasible shorter route was found');}
    }));
    await check('clear walking limit and preserve places', event => revise('Remove the shorter-walk preference. Keep these same three places.', event, (before, after) => {
      assert.deepEqual(ids(after), ids(before)); assert.deepEqual(after.input, before.input);
    }));
    if (scenario.name === 'nyc-near-venue') {
      await check('high-end dining in a mixed three-stop route', event => revise('Remove all earlier place preferences. Keep exactly three stops with at least one high-end restaurant.', event, (_before, after) => {
        assert.equal(after.stops.length, 3); assert.ok(after.stops.some(stop => stop.category === 'food' && stop.diningEvidence?.fineDining && stop.costTier !== 1 && stop.durationMinutes >= 90));
      }));
      await check('unverifiable current Michelin-only claim is guarded', event => revise('Only currently Michelin-starred restaurants, please.', event, (before, after, result) => {
        assert.deepEqual(after, before); assert.match(result.message ?? '', /verify|verified|Michelin/i);
      }));
      await check('replace premium preference with cheaper cafes', event => revise('Remove the high-end restaurant requirement. Make it cheaper, with three stops and at least one café.', event, (before, after, result) => {
        if (after.input.budget === 'low') {assert.equal(after.stops.length, 3); assert.ok(after.stops.some(stop => stop.category === 'food')); assert.ok(after.stops.every(stop => !stop.diningEvidence?.fineDining));}
        else {assert.deepEqual(after, before); assert.match(result.message ?? '', /price|budget|verified|fit/i); event.checks.push('Unknown prices must produce a truthful guard rather than a fabricated low-price route');}
      }));
    }
  }
  await check('stop-limit guard', event => revise('Add two more stops to this three-stop plan.', event, (before, after, result) => {assert.deepEqual(after, before); assert.match(result.message ?? '', /three|3/); assert.match(result.message ?? '', /supports|up to|maximum|limit/i);}));
  await check('read-only explanation', event => revise('Why do these places fit my taste?', event, (before, after, result) => {assert.deepEqual(after, before); assert.ok(result.message && result.message.length > 20); assert.doesNotMatch(result.message, /could not fit|could not find a different outing/i);}));
  await check('session reload preserves conversation', async event => {const restored = await api<{itinerary: Itinerary; messages: {role: string; text: string}[]}>('GET', '/api/session'); assert.deepEqual(restored.itinerary, plan); assert.ok(restored.messages.length >= 5); assert.equal(restored.messages.at(-2)?.text, 'Why do these places fit my taste?'); event.checks.push('Current route and multi-turn messages survive session reload');});
}
try {for (const [index, scenario] of scenarios.entries()) await run(scenario, index); await save(); console.log(JSON.stringify({report: `${outDir}/${runId}.json`, scenarios: scenarios.length, actions: scenarios.reduce((n, scenario) => n + scenario.events.length, 0), failures: scenarios.reduce((n, scenario) => n + scenario.failures.length, 0), providerCalls})); if (scenarios.some(scenario => scenario.failures.length)) process.exitCode = 1;}
finally {globalThis.fetch = realFetch; await app.close();}
