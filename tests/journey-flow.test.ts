import test from 'node:test';
import assert from 'node:assert/strict';
import {journeyAction, journeyFailureStep, reachableJourneyStep} from '../src/client/journey-flow.js';

const complete = {artist: true, venue: true, schedule: true};

test('forward navigation advances one stage and can submit only from timing', () => {
  assert.deepEqual(journeyAction(0, complete), {kind: 'advance', step: 1});
  assert.deepEqual(journeyAction(1, complete), {kind: 'advance', step: 2});
  assert.deepEqual(journeyAction(2, complete), {kind: 'submit'});
  assert.deepEqual(journeyAction(0, {...complete, venue: false, schedule: false}), {kind: 'advance', step: 1});
  assert.deepEqual(journeyAction(1, {...complete, schedule: false}), {kind: 'advance', step: 2});
});

test('clearing a selected artist relocks later stages and routes submission to the missing field', () => {
  const ready = {...complete, artist: false};
  assert.equal(reachableJourneyStep(1, ready), 0);
  assert.equal(reachableJourneyStep(2, ready), 0);
  for (const step of [0, 1, 2] as const) {
    assert.deepEqual(journeyAction(step, ready), {kind: 'incomplete', step: 0, field: 'artist'});
  }
});

test('clearing a selected venue relocks timing and is checked again at final submission', () => {
  const ready = {...complete, venue: false};
  assert.equal(reachableJourneyStep(1, ready), 1);
  assert.equal(reachableJourneyStep(2, ready), 1);
  assert.deepEqual(journeyAction(1, ready), {kind: 'incomplete', step: 1, field: 'venue'});
  assert.deepEqual(journeyAction(2, ready), {kind: 'incomplete', step: 1, field: 'venue'});
});

test('backward navigation does not require later selections or a valid schedule', () => {
  assert.equal(reachableJourneyStep(0, {artist: false, venue: false}), 0);
  assert.equal(reachableJourneyStep(0, complete), 0);
  assert.equal(reachableJourneyStep(1, {...complete, venue: false}), 1);
  assert.equal(reachableJourneyStep(2, complete), 2);
});

test('an invalid schedule prevents final submission without changing earlier progression', () => {
  assert.deepEqual(journeyAction(2, {...complete, schedule: false}), {kind: 'incomplete', step: 2, field: 'schedule'});
  assert.deepEqual(journeyAction(2, {artist: false, venue: false, schedule: false}), {kind: 'incomplete', step: 0, field: 'artist'});
});

test('field failures reveal their stage while general failures preserve the current stage', () => {
  assert.equal(journeyFailureStep('artist'), 0);
  assert.equal(journeyFailureStep('venue'), 1);
  assert.equal(journeyFailureStep('startingPoint'), 1);
  assert.equal(journeyFailureStep('general'), undefined);
  assert.equal(journeyFailureStep('unknown'), undefined);
});
