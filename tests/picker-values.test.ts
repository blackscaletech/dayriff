import test from 'node:test';
import assert from 'node:assert/strict';
import {addDays, clockValue, dateInRange, dateParts, dateSeed, fullDateLabel, monthDays, monthLength, shiftMonth, timeInRange, timeParts, timeSeed, twelveHour, weekday} from '../src/client/components/date-time/values.js';

test('calendar accepts actual days, including Gregorian leap-year boundaries', () => {
  assert.equal(monthLength(2024, 2), 29);
  assert.equal(monthLength(2000, 2), 29);
  assert.equal(monthLength(2100, 2), 28);
  assert.ok(dateParts('2024-02-29'));
  assert.equal(dateParts('2026-02-29'), undefined);
  assert.equal(dateParts('2026-04-31'), undefined);
  assert.equal(dateParts('2026-13-01'), undefined);
  assert.equal(dateParts('2026-1-01'), undefined);
  assert.equal(dateParts('0000-01-01'), undefined);
  assert.deepEqual(dateParts('0001-01-01'), {year: 1, month: 1, day: 1});
});

test('month navigation clamps end dates and crosses years without overflow', () => {
  assert.equal(shiftMonth('2026-01-31', 1), '2026-02-28');
  assert.equal(shiftMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(shiftMonth('2026-03-31', -1), '2026-02-28');
  assert.equal(shiftMonth('2026-12-31', 1), '2027-01-31');
  assert.equal(shiftMonth('2026-01-31', -1), '2025-12-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('0001-01-01', -1), undefined);
  assert.equal(addDays('9999-12-31', 1), undefined);
  assert.equal(shiftMonth('0001-01-01', -1), undefined);
});

test('calendar grid starts on Sunday and retains stable, correctly dated weeks', () => {
  const days = monthDays('2026-10-15');
  assert.equal(days.length, 42);
  assert.equal(days[0].value, '2026-09-27');
  assert.equal(days[41].value, '2026-11-07');
  assert.equal(days.filter(day => day.inMonth).length, 31);
  assert.equal(weekday('2026-10-01'), 4);
  assert.equal(fullDateLabel('2026-10-15'), 'Thursday, October 15, 2026');
  assert.ok(monthDays('2024-02-01').some(day => day.value === '2024-02-29' && day.inMonth));
});

test('date constraints include their boundaries and seed within supplied limits', () => {
  assert.equal(dateInRange('2026-10-15', '2026-10-15', '2026-10-21'), true);
  assert.equal(dateInRange('2026-10-21', '2026-10-15', '2026-10-21'), true);
  assert.equal(dateInRange('2026-10-14', '2026-10-15', '2026-10-21'), false);
  assert.equal(dateInRange('invalid'), false);
  assert.equal(dateSeed('2026-09-01', '2026-10-15', '2026-10-21'), '2026-10-15');
  assert.equal(dateSeed('2026-11-01', '2026-10-15', '2026-10-21'), '2026-10-21');
});

test('clock selection preserves midnight, noon, and exact minutes', () => {
  assert.equal(clockValue(12, 0, 'AM'), '00:00');
  assert.equal(clockValue(12, 0, 'PM'), '12:00');
  assert.equal(clockValue(1, 7, 'PM'), '13:07');
  assert.equal(clockValue(0, 0, 'AM'), undefined);
  assert.equal(clockValue(13, 0, 'PM'), undefined);
  assert.equal(clockValue(2, 60, 'PM'), undefined);
  assert.equal(timeParts('24:00'), undefined);
  assert.equal(timeParts('14:60'), undefined);
  assert.deepEqual(twelveHour('00:09'), {hour: 12, minute: 9, period: 'AM'});
  assert.deepEqual(twelveHour('12:09'), {hour: 12, minute: 9, period: 'PM'});
});

test('time constraints support inclusive limits and overnight ranges', () => {
  assert.equal(timeInRange('18:30', '18:30', '20:00'), true);
  assert.equal(timeInRange('20:00', '18:30', '20:00'), true);
  assert.equal(timeInRange('18:29', '18:30', '20:00'), false);
  assert.equal(timeInRange('23:30', '21:00', '02:00'), true);
  assert.equal(timeInRange('01:30', '21:00', '02:00'), true);
  assert.equal(timeInRange('12:00', '21:00', '02:00'), false);
  assert.equal(timeSeed('', '20:00', '23:00'), '20:00');
  assert.equal(timeSeed('01:30', '21:00', '02:00'), '01:30');
});
