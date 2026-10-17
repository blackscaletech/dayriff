import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVisitInfo } from '../src/server/providers/visit-info.js';

test('visit information preserves provider phone, neighborhood and listed weekly periods', () => {
  assert.deepEqual(normalizeVisitInfo({phone: '+1 (212) 219-2166', neighborhood: 'SoHo', hours: {
    wednesday: [{closed: false, opens: 'T12:00:00', closes: 'T18:00:00'}],
    monday: [{closed: true}],
    friday: [{closed: false, opens: '09:30', closes: '12:00'}, {closed: false, opens: 'T13:00:00', closes: 'T18:00:00'}],
  }}), {phone: '+1 (212) 219-2166', neighborhood: 'SoHo', openingHours: [
    {day: 'monday', closed: true, periods: []},
    {day: 'wednesday', closed: false, periods: [{opens: '12:00', closes: '18:00'}]},
    {day: 'friday', closed: false, periods: [{opens: '09:30', closes: '12:00'}, {opens: '13:00', closes: '18:00'}]},
  ]});
});
test('malformed contact details and incomplete schedules are omitted rather than inferred', () => {
  assert.deepEqual(normalizeVisitInfo({phone: '+1212;alert(1)', neighborhood: {}, hours: {
    someday: [{closed: false, opens: 'T12:00:00', closes: 'T18:00:00'}],
    monday: [{closed: false, opens: 'T25:00:00', closes: 'T18:00:00'}],
    tuesday: [{closed: true}, {closed: false, opens: 'T12:00:00', closes: 'T18:00:00'}],
    wednesday: [{closed: false, opens: 'T12:00:00'}],
    thursday: [{closed: false, opens: 'T12:00:00', closes: 'T18:00:00'}, {closed: false, opens: 'noon', closes: 'evening'}],
  }}), {});
  assert.deepEqual(normalizeVisitInfo({}), {});
});
