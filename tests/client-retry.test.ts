import test from 'node:test';
import assert from 'node:assert/strict';
import type {ChatMessage, Itinerary} from '../src/shared/types.js';
import {completedMutation, snapshotMutation} from '../src/client/retry.js';
const plan = (revision: number, id = 'plan') => ({id, revision}) as Itinerary;
const pair = (text: string, reply = 'Updated.') => [{role: 'user', text}, {role: 'assistant', text: reply}] as ChatMessage[];

test('a committed revision with a lost response is adopted instead of posted a second time', () => {
  const before: ChatMessage[] = [{role: 'assistant', text: 'Your plan.'}];
  const snapshot = snapshotMutation(plan(2), before, 'More culture');
  assert.equal(completedMutation(snapshot, {itinerary: plan(3), messages: [...before, ...pair('More culture')]}), 'changed');
  assert.equal(completedMutation(snapshot, {itinerary: plan(3), messages: [...before, ...pair('Less walking')]}), null);
  assert.equal(completedMutation(snapshot, {itinerary: plan(3, 'other'), messages: pair('More culture')}), null);
});

test('a repeated request already present before the failed attempt is not mistaken for a new answer', () => {
  const before = pair('More culture');
  const snapshot = snapshotMutation(plan(2), before, 'More culture');
  assert.equal(completedMutation(snapshot, {itinerary: plan(2), messages: [...before]}), null);
  assert.equal(completedMutation(snapshot, {itinerary: plan(2), messages: [...before, ...pair('More culture', 'Here is why.')]}), 'answered');
});

test('read-only replies reconcile correctly when retained conversation history rolls forward', () => {
  const before = [...pair('First'), ...pair('Second'), ...pair('Third')];
  const snapshot = snapshotMutation(plan(2), before, 'More culture');
  assert.equal(completedMutation(snapshot, {itinerary: plan(2), messages: [...before.slice(2), ...pair('More culture')]}), 'answered');
  assert.equal(completedMutation(snapshot, {itinerary: plan(2), messages: pair('More culture')}), null);
});
