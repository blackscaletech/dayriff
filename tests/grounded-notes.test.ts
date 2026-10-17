import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place } from '../src/shared/types.js';
import { applyGroundedNotes, type GroundedStopNote } from '../src/server/services/grounded-notes.js';

const place: Place = {id: 'trusted-shop', name: 'Neighborhood Records', category: 'shop', address: '', coordinates: {latitude: 40.7, longitude: -74}, durationMinutes: 25,
  description: 'The shop specializes in used jazz, soul and funk vinyl, with a collection of local music zines.'};
const valid: GroundedStopNote = {id: place.id, note: 'Used vinyl is the focus, spanning jazz, soul and funk.', evidence_quote: 'THE SHOP specializes in used jazz,\n soul and funk vinyl'};

test('notes require the same trusted place, substantive contiguous evidence and a concise paraphrase', () => {
  const result = applyGroundedNotes([place], [valid]);
  assert.equal(result[0]?.localNote, valid.note);
  assert.equal(place.localNote, undefined, 'the input place is never mutated');
  const invalid = [
    {...valid, id: 'another-place'},
    {...valid, evidence_quote: 'The shop specializes in used jazz and local music zines.'},
    {...valid, note: 'The shop specializes in used jazz, soul and funk vinyl.'},
    {...valid, note: 'A lovely local stop to explore before your concert.'},
    {...valid, note: 'Jazz '.repeat(60)},
  ];
  for (const note of invalid) assert.equal(applyGroundedNotes([place], [note])[0]?.localNote, undefined);
  assert.equal(applyGroundedNotes([{...place, description: 'A nearby place found by Qloo.'}], [valid])[0]?.localNote, undefined);
  const verified = {...place, localNote: 'An existing independently verified local note.'};
  assert.equal(applyGroundedNotes([verified], [invalid[1]!])[0]?.localNote, verified.localNote);
});

test('unsupported numbers, proper names, history and visitor rules are omitted even with high word overlap', () => {
  for (const note of [
    'Used vinyl is the focus, spanning jazz, soul and funk since 1978.',
    'Used vinyl is the focus, spanning jazz, soul and funk for two generations.',
    'Used vinyl is the focus, spanning jazz, soul and funk with Bowie.',
    'Used vinyl is the focus, spanning jazz, soul and funk in this historic shop.',
    'Used vinyl is the focus, spanning jazz, soul and funk; photography is allowed.',
    'Used vinyl is the focus, spanning jazz, soul and funk; no photography.',
  ]) assert.equal(applyGroundedNotes([place], [{...valid, note}])[0]?.localNote, undefined, note);
  const dated = {...place, description: `${place.description} Opened in 1978.`};
  assert.equal(applyGroundedNotes([dated], [{...valid, note: 'Used vinyl is the focus, spanning jazz, soul and funk since 1978.'}])[0]?.localNote, undefined,
    'a number elsewhere in the description does not support the supplied quote');
});
