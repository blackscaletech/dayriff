import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestError} from '../src/client/api.js';
import {describeFailure, toFailure} from '../src/client/failures.js';

test('genuine starting-point errors attach to the field, while lookup outages invite retry', () => {
  const clarification = toFailure(new RequestError('Which hotel?', 422, 'START_NEEDS_DETAILS'), 'create');
  assert.equal(clarification.code, 'START_NEEDS_DETAILS');
  assert.equal(clarification.status, 422);
  assert.equal(describeFailure(clarification).location, 'startingPoint');
  assert.equal(describeFailure(clarification).recovery, 'editStartingPoint');
  const outage = toFailure(new RequestError('Search is unavailable.', 503, 'START_UNAVAILABLE'), 'create');
  assert.equal(describeFailure(outage).location, 'general');
  assert.equal(describeFailure(outage).recovery, 'retry');
  const temporary = toFailure(new RequestError('Please try again.', 503, 'INVALID_START'), 'create');
  assert.equal(describeFailure(temporary).location, 'general');
  assert.equal(describeFailure(temporary).recovery, 'retry');
});

test('network, busy and rate-limit errors keep valid inputs and expose a real retry path', () => {
  const network = toFailure(new TypeError('Failed to fetch'), 'revise', {request: 'More culture'});
  assert.equal(network.request, 'More culture');
  assert.doesNotMatch(network.message, /Failed to fetch/);
  assert.equal(describeFailure(network).recovery, 'retry');
  for (const [status, code] of [[502, 'PROVIDER_ERROR'], [429, 'RATE_LIMITED'], [409, 'PLAN_BUSY']] as const) {
    assert.equal(describeFailure(toFailure(new RequestError('Please try again.', status, code), 'create')).recovery, 'retry');
  }
});

test('expired plans lead to rebuilding from saved details instead of repeating a failed mutation', () => {
  const expired = toFailure(new RequestError('Create a new plan.', 404, 'PLAN_NOT_FOUND'), 'restore', {versionId: 'earlier'});
  assert.equal(describeFailure(expired).recovery, 'editPlan');
  assert.equal(describeFailure(expired).title, 'This plan has expired');
  assert.equal(expired.versionId, 'earlier');
});

test('genuine expired selection IDs point to the artist or venue instead of a global retry', () => {
  assert.equal(describeFailure(toFailure(new RequestError('Choose the artist again.', 422, 'ARTIST_NOT_FOUND'), 'create')).location, 'artist');
  assert.equal(describeFailure(toFailure(new RequestError('Choose the venue again.', 422, 'VENUE_NOT_FOUND'), 'create')).location, 'venue');
});

test('daily allowances explain the limit without offering a repeated paid request', () => {
  for (const code of ['DAILY_LIMIT', 'DAILY_SEARCH_LIMIT', 'SESSION_DAILY_LIMIT', 'PROVIDER_DAILY_LIMIT']) {
    const failure = toFailure(new RequestError('Your saved trip is still available. Try more changes tomorrow.', 429, code), 'revise');
    assert.match(describeFailure(failure).title, /Daily (?:search|planning) allowance reached/);
    assert.equal(describeFailure(failure).recovery, 'none');
    assert.match(failure.message, /saved trip is still available/);
  }
  for (const code of ['QUOTA_UNAVAILABLE', 'STORAGE_UNAVAILABLE']) assert.equal(describeFailure(toFailure(new RequestError('Please try again shortly.', 503, code), 'revise')).recovery, 'retry');
});

test('a changed trip explains safe reload instead of repeating a stale mutation', () => {
  const failure = toFailure(new RequestError('This trip changed in another window.', 409, 'PLAN_CHANGED'), 'revise');
  assert.equal(describeFailure(failure).title, 'This trip changed');
  assert.equal(describeFailure(failure).recovery, 'none');
  assert.match(failure.message, /saved trip is safe/);
  assert.match(failure.message, /Reload Dayriff/);
});
