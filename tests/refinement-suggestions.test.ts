import assert from 'node:assert/strict';
import test from 'node:test';
import type {ChatMessage, Itinerary, Stop} from '../src/shared/types.js';
import {refinementSuggestions} from '../src/client/refinement-suggestions.js';

const stop = (category: Stop['category'], costTier: Stop['costTier'] = 2): Stop => ({
  id: category, name: category, category, costTier, address: '', coordinates: {latitude: 40.75, longitude: -73.99},
  description: '', durationMinutes: 35, arrivalTime: '16:00', departureTime: '16:35', arrivalDate: '2026-10-21', departureDate: '2026-10-21', walkMinutes: 10, reason: '',
});
const plan: Pick<Itinerary, 'input' | 'stops' | 'totalWalkMinutes'> = {
  input: {artist: {id: 'artist', name: 'Artist'}, venueId: 'venue', date: '2026-10-21', showTime: '19:00', durationMinutes: 180, startingPoint: ''},
  stops: [stop('culture'), stop('food')], totalWalkMinutes: 85,
};
const user = (text: string): ChatMessage => ({role: 'user', text});

test('shortcuts use the current route and do not imply missing factual evidence', () => {
  const suggestions = refinementSuggestions([], plan);
  assert.equal(suggestions.length, 3);
  assert.equal(new Set(suggestions).size, 3);
  assert.equal(suggestions[0], 'Less walking');
  assert.ok(suggestions.includes('Make it cheaper'));
  assert.ok(!suggestions.some(text => /michelin|open|verified/i.test(text)));
  const culturalOnly = refinementSuggestions([], {...plan, stops: [stop('culture')], totalWalkMinutes: 10});
  assert.equal(culturalOnly[0], 'Add a café');
  assert.ok(!culturalOnly.includes('Less walking'));
});

test('follow-up shortcuts change after turns and avoid semantic repeats', () => {
  const messages = [user('Can we keep the places closer together with less walking?'), {role: 'assistant' as const, text: 'The new plan has less walking.'}, user('more museums please')];
  const suggestions = refinementSuggestions(messages, plan);
  assert.equal(suggestions.length, 3);
  assert.ok(!suggestions.includes('Less walking'));
  assert.ok(!suggestions.includes('More culture'));
  assert.ok(suggestions.includes('Why these places?'));
  assert.notDeepEqual(suggestions, refinementSuggestions([], plan));
});

test('budget and dining preferences prevent contradictory budget shortcuts', () => {
  assert.ok(!refinementSuggestions([], {...plan, input: {...plan.input, budget: 'low'}}).includes('Make it cheaper'));
  assert.ok(!refinementSuggestions([user('Find high end restaurants, Michelin star if possible')], plan).includes('Make it cheaper'));
  assert.equal(refinementSuggestions([user('Find high end restaurants')], plan)[0], 'Less walking');
  const premium = refinementSuggestions([user('Fine dining please')], {...plan, totalWalkMinutes: 10});
  assert.ok(premium.includes('What should I book ahead?'));
  assert.ok(!premium.includes('Add a café'));
  assert.ok(!premium.some(text => /michelin/i.test(text)));
});

test('a full or short outing is not prompted to add another stop', () => {
  for (const current of [
    {...plan, stops: [stop('food'), stop('culture'), stop('shop')]},
    {...plan, totalWalkMinutes: 10, input: {...plan.input, durationMinutes: 90}},
  ]) assert.ok(!refinementSuggestions([], current).includes('Add another stop'));
  assert.ok(!refinementSuggestions([user('I want at least 3 stops')], {...plan, totalWalkMinutes: 20}).includes('Add another stop'));
});

test('assistant prose cannot accidentally suppress useful user actions', () => {
  const assistant: ChatMessage = {role: 'assistant', text: 'More culture, less walking, make it cheaper, local shops.'};
  assert.deepEqual(refinementSuggestions([assistant], plan), refinementSuggestions([], plan));
  assert.ok(refinementSuggestions([], undefined).length >= 2);
});
