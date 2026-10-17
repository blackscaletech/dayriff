import assert from 'node:assert/strict';
import test from 'node:test';
import {explorationRangeLabel, journeyTimeLabel} from '../src/client/format.js';
import {derivePlanningWindow} from '../src/shared/planning-window.js';
import {planInputSchema} from '../src/server/validation.js';
import {checkPlan, suggestStopIds} from '../src/server/services/planner.js';
import type {Place, PlanInput, Venue} from '../src/shared/types.js';

const venue: Venue = {id: 'concert', name: 'Concert', city: 'New York', address: '', coordinates: {latitude: 40.75, longitude: -73.99}, website: '', timezone: 'America/New_York'};
const input: PlanInput = {artist: {id: 'artist', name: 'Artist'}, venueId: venue.id, date: '2026-10-22', showTime: '19:00', durationMinutes: 180, startingPoint: 'Near the venue'};

test('show time backtracks the whole outing from a visible default arrival buffer without creating optional inputs', () => {
  const snapshot = structuredClone(input);
  const window = derivePlanningWindow(input);
  assert.equal(window.showMinutes, 19 * 60);
  assert.equal(window.arrivalMinutes, 18 * 60 + 30);
  assert.equal(window.startMinutes, 15 * 60 + 30);
  assert.equal(window.startTime, '15:30');
  assert.equal(window.arrivalTime, '18:30');
  assert.equal(window.arrivalBufferMinutes, 30);
  assert.equal(window.startDate, input.date);
  assert.deepEqual(input, snapshot);
  const parsed = planInputSchema.parse({...input, budget: null, arrivalBy: ''});
  assert.equal(parsed.arrivalBy, undefined);
  assert.equal(parsed.budget, undefined);
  const {showTime: _showTime, ...missingShowTime} = input;
  assert.equal(planInputSchema.safeParse({...missingShowTime, startTime: '15:30'}).success, false, 'A legacy start clock cannot silently become the show clock');
});

test('explicit venue arrival overrides the default buffer and duration changes move the starting time', () => {
  const explicit = {...input, arrivalBy: '18:45'};
  const window = derivePlanningWindow(explicit);
  assert.equal(window.arrivalTime, '18:45');
  assert.equal(window.startTime, '15:45');
  assert.equal(window.arrivalBufferMinutes, 15);
  assert.equal(derivePlanningWindow({...explicit, durationMinutes: 240}).startTime, '14:45');
  assert.equal(derivePlanningWindow({...explicit, durationMinutes: 120}).startTime, '16:45');
  assert.equal(derivePlanningWindow({...input, arrivalBy: '19:00'}).arrivalBufferMinutes, 0);
});

test('malformed times, impossible dates and incompatible arrival targets fail before route planning', () => {
  for (const patch of [
    {showTime: '24:00'}, {showTime: '19:60'}, {showTime: '7 pm'}, {date: '2026-02-30'},
    {durationMinutes: 29}, {durationMinutes: 481}, {durationMinutes: 90.5},
    {arrivalBy: '20:00'}, {arrivalBy: '06:59'}, {arrivalBy: '25:00'},
  ]) {
    assert.throws(() => derivePlanningWindow({...input, ...patch}), RangeError, JSON.stringify(patch));
    assert.equal(planInputSchema.safeParse({...input, ...patch}).success, false, JSON.stringify(patch));
  }
  assert.equal(planInputSchema.safeParse({...input, arrivalBy: '07:00'}).success, true, 'An explicit arrival exactly twelve hours before the show is unambiguous');
});

test('an after-midnight show keeps the previous evening and year or leap-day boundary dates', () => {
  const late = {...input, showTime: '01:00'};
  const window = derivePlanningWindow(late);
  assert.equal(window.showDate, '2026-10-22');
  assert.equal(window.arrivalDate, '2026-10-22');
  assert.equal(window.arrivalTime, '00:30');
  assert.equal(window.startDate, '2026-10-21');
  assert.equal(window.startTime, '21:30');
  assert.equal(window.startMinutes, -150);
  const earlyArrival = derivePlanningWindow({...late, arrivalBy: '23:00'});
  assert.equal(earlyArrival.arrivalDate, '2026-10-21');
  assert.equal(earlyArrival.arrivalMinutes, -60);
  assert.equal(earlyArrival.startTime, '20:00');
  assert.equal(earlyArrival.startDate, '2026-10-21');
  assert.equal(derivePlanningWindow({...late, date: '2027-01-01'}).startDate, '2026-12-31');
  assert.equal(derivePlanningWindow({...late, date: '2024-03-01'}).startDate, '2024-02-29');
});

test('walking and visits can use the full supplied duration up to the selected arrival without another hidden buffer', async () => {
  const place: Place = {id: 'gallery', name: 'Local Gallery', category: 'culture', address: '', coordinates: venue.coordinates, description: 'A local art gallery.', durationMinutes: 26};
  const checked = await checkPlan({ids: [place.id], input: {...input, durationMinutes: 30, arrivalBy: '18:45'}, venue, candidates: [place], mode: 'live'});
  assert.ok(checked.itinerary, checked.issues.join(' '));
  assert.equal(checked.itinerary.totalWalkMinutes, 4);
  assert.equal(checked.itinerary.totalMinutes, 30);
  assert.equal(checked.itinerary.stops[0]!.arrivalTime, '18:17');
  assert.equal(checked.itinerary.stops[0]!.departureTime, '18:43');
  assert.equal(checked.itinerary.estimatedArrival, '18:45');
  assert.equal(checked.itinerary.estimatedArrivalDate, input.date);
  assert.doesNotMatch(checked.itinerary.notices.join(' '), /10.minute.*buffer/);
});

test('ranking and validation check real previous-day hours and return dates alongside clocks', async () => {
  const place: Place = {id: 'late-gallery', name: 'Late Gallery', category: 'culture', address: '', coordinates: venue.coordinates, description: 'A local art gallery.', durationMinutes: 35,
    openingHours: [{day: 'wednesday', closed: false, periods: [{opens: '21:00', closes: '23:00'}]}, {day: 'thursday', closed: true, periods: []}]};
  const late = {...input, showTime: '01:00'};
  assert.deepEqual(suggestStopIds(late, venue, [place]), [place.id]);
  const checked = await checkPlan({ids: [place.id], input: late, venue, candidates: [place], mode: 'live'});
  assert.ok(checked.itinerary, checked.issues.join(' '));
  assert.equal(checked.itinerary.stops[0]!.arrivalDate, '2026-10-21');
  assert.equal(checked.itinerary.stops[0]!.departureDate, '2026-10-21');
  assert.equal(checked.itinerary.stops[0]!.arrivalTime, '21:32');
  assert.equal(checked.itinerary.estimatedArrivalDate, '2026-10-21');
  assert.equal(checked.itinerary.estimatedArrival, '22:09');
  const closed = await checkPlan({ids: [place.id], input: {...late, date: '2026-10-23'}, venue, candidates: [place], mode: 'live'});
  assert.equal(closed.valid, false, 'Friday shows start on Thursday, when this gallery is closed');
  assert.match(closed.issues.join(' '), /listed hours/);
  const overnight = {...place, durationMinutes: 90, openingHours: [{day: 'wednesday', closed: false, periods: [{opens: '21:00', closes: '02:00'}]}, {day: 'thursday', closed: true, periods: []}]};
  const crossesMidnight = await checkPlan({ids: [place.id], input: {...late, showTime: '02:00', durationMinutes: 120}, venue, candidates: [overnight], mode: 'live'});
  assert.ok(crossesMidnight.itinerary, crossesMidnight.issues.join(' '));
  assert.equal(crossesMidnight.itinerary.stops[0]!.arrivalDate, '2026-10-21');
  assert.equal(crossesMidnight.itinerary.stops[0]!.arrivalTime, '23:32');
  assert.equal(crossesMidnight.itinerary.stops[0]!.departureDate, '2026-10-22');
  assert.equal(crossesMidnight.itinerary.stops[0]!.departureTime, '01:02');
  assert.equal(crossesMidnight.itinerary.estimatedArrivalDate, '2026-10-22');
  assert.equal(crossesMidnight.itinerary.estimatedArrival, '01:04');
});


test('journey labels identify the previous evening and both dates of an overnight exploration window', () => {
  assert.equal(journeyTimeLabel('2026-10-22', '19:00', '2026-10-22'), '7:00 PM');
  assert.equal(journeyTimeLabel('2026-10-21', '23:32', '2026-10-22'), 'Wed, Oct 21 · 11:32 PM');
  assert.equal(explorationRangeLabel(derivePlanningWindow({...input, showTime: '01:00'})), 'Wed, Oct 21 · 9:30 PM – Thu, Oct 22 · 12:30 AM');
  assert.equal(explorationRangeLabel(derivePlanningWindow({...input, showTime: '01:00', arrivalBy: '23:00'})), 'Wed, Oct 21 · 8:00 PM–11:00 PM');
});

test('a midnight show schedules its full outing and default arrival on the previous calendar day', async () => {
  const midnight = {...input, showTime: '00:00'};
  const window = derivePlanningWindow(midnight);
  assert.equal(window.showDate, '2026-10-22');
  assert.equal(window.startDate, '2026-10-21');
  assert.equal(window.startTime, '20:30');
  assert.equal(window.arrivalDate, '2026-10-21');
  assert.equal(window.arrivalTime, '23:30');
  assert.equal(window.startMinutes, -210);
  assert.equal(window.arrivalMinutes, -30);
  assert.equal(planInputSchema.safeParse(midnight).success, true);
  const place: Place = {id: 'night-stop', name: 'Night Stop', category: 'culture', address: '', coordinates: venue.coordinates, description: '', durationMinutes: 35};
  const checked = await checkPlan({ids: [place.id], input: midnight, venue, candidates: [place], mode: 'live'});
  assert.ok(checked.itinerary, checked.issues.join(' '));
  assert.equal(checked.itinerary.stops[0]!.arrivalDate, '2026-10-21');
  assert.equal(checked.itinerary.estimatedArrivalDate, '2026-10-21');
});

test('the twelve-hour arrival boundary remains inclusive and date-correct across midnight and noon', () => {
  const midnight = {...input, showTime: '00:00', arrivalBy: '12:00'};
  const previousNoon = derivePlanningWindow(midnight);
  assert.equal(previousNoon.arrivalDate, '2026-10-21');
  assert.equal(previousNoon.arrivalTime, '12:00');
  assert.equal(previousNoon.arrivalBufferMinutes, 720);
  assert.equal(planInputSchema.safeParse(midnight).success, true);
  assert.equal(derivePlanningWindow({...midnight, arrivalBy: '12:01'}).arrivalBufferMinutes, 719);
  assert.throws(() => derivePlanningWindow({...midnight, arrivalBy: '11:59'}), RangeError);
  const noon = {...input, showTime: '12:00', arrivalBy: '00:00'};
  assert.equal(derivePlanningWindow(noon).arrivalDate, '2026-10-22');
  assert.equal(derivePlanningWindow(noon).startDate, '2026-10-21');
  assert.equal(derivePlanningWindow(noon).arrivalBufferMinutes, 720);
  assert.equal(derivePlanningWindow({...noon, arrivalBy: '00:01'}).arrivalBufferMinutes, 719);
  assert.throws(() => derivePlanningWindow({...noon, arrivalBy: '23:59'}), RangeError);
});
