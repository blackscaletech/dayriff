import assert from 'node:assert/strict';
import test from 'node:test';
import type {Place} from '../src/shared/types.js';
import {isIdentifyingPlaceTag, providerTag} from '../src/server/providers/provider-tags.js';
import {diningEvidence, FINE_DINING_TAGS, MICHELIN_COLLECTION} from '../src/server/providers/dining-evidence.js';
import {matchesPlaceQuery, placeCategory, qlooTaxonomy} from '../src/server/providers/qloo.js';

const fineDining = FINE_DINING_TAGS[0]!;
const cafe = 'urn:tag:category:place:cafe';
const library = 'urn:tag:category:place:public_library';
const bookshop = 'urn:tag:category:place:book_store';
const typed = (value: string, type = 'urn:tag:category:place', name = 'Provider label') => ({value, type, name});

test('shared provider tags accept full-URN id, tag_id and value forms without promoting labels', () => {
  for (const value of [fineDining, {id: fineDining}, {tag_id: fineDining}, typed(fineDining), {id: 'provider-row-id', ...typed(fineDining)}]) {
    assert.equal(providerTag(value)?.id, fineDining);
    assert.deepEqual(diningEvidence({tags: [value]}), {fineDining: true});
  }
  for (const value of [typed('fine_dining'), {name: fineDining}, typed(`https://example.test/${fineDining}`), typed(`${fineDining}?extra=1`)]) {
    assert.equal(providerTag(value), undefined);
    assert.equal(diningEvidence({tags: [value]}), undefined);
  }
});

test('dining facets and collection evidence remain separate from identifying place categories', () => {
  const facets = [
    typed('urn:tag:culinary_style:qloo:fine_dining', 'urn:tag:culinary_style:qloo'),
    typed('urn:tag:dining_option:qloo:fine_dining', 'urn:tag:dining_option:qloo'),
    typed(MICHELIN_COLLECTION, 'urn:tag:resy:collection:place'),
  ];
  assert.deepEqual(diningEvidence({tags: facets}), {fineDining: true, michelinCollection: true});
  assert.deepEqual(qlooTaxonomy({tags: facets}), []);
  assert.equal(isIdentifyingPlaceTag(MICHELIN_COLLECTION), false);
  assert.equal(placeCategory({tags: [typed(library), ...facets]}), 'culture');
  assert.equal(diningEvidence({tags: [typed(MICHELIN_COLLECTION, 'urn:tag:resy:collection:place')]} )?.fineDining, undefined, 'Collection membership is not fine-dining or current-star verification');
});

test('ancillary or reused labels cannot override a trusted tag identity or grant dining evidence', () => {
  const falseEvidence = [
    typed(fineDining, 'urn:tag:amenity:place', 'Fine dining'),
    typed(MICHELIN_COLLECTION, 'urn:tag:nearby_attraction:qloo', 'Michelin Winners'),
    {id: cafe, ...typed(fineDining, 'urn:tag:category:place', 'Fine dining')},
    typed('urn:tag:nearby_attraction:qloo:fine_dining', 'urn:tag:nearby_attraction:qloo', 'Fine dining'),
  ];
  for (const tag of falseEvidence) assert.equal(diningEvidence({tags: [tag]}), undefined);
  assert.equal(placeCategory({tags: [typed(cafe, 'urn:tag:category:place', 'National Library Archive')]}), 'food');
  assert.deepEqual(qlooTaxonomy({tags: [typed(library, 'urn:tag:amenity:place', 'Library')]}), []);
});

test('library and archive taxonomy stays cultural despite secondary dining while bookshops remain shops', () => {
  for (const kind of ['library', 'public_library', 'national_library', 'research_library', 'archive', 'archives', 'historical_archive']) {
    assert.equal(placeCategory({tags: [typed(`urn:tag:category:place:${kind}`), typed(cafe)]}), 'culture', kind);
  }
  assert.equal(placeCategory({tags: [typed('urn:tag:genre:place:library:public', 'urn:tag:genre:place'), typed(cafe)]}), 'culture');
  assert.equal(placeCategory({name: 'Library Bookshop', tags: [typed(bookshop, 'urn:tag:category:place', 'Library')]}), 'shop');
  assert.equal(placeCategory({name: 'Library Café', tags: [typed(cafe)]}), 'food');
  assert.equal(placeCategory({tags: [typed('urn:tag:genre:place:restaurant:library_cafe', 'urn:tag:genre:place')]}), 'food');
  const base: Place = {id: 'place', name: 'Library Bookshop', category: 'shop', address: '', coordinates: {latitude: 40, longitude: -74}, description: '', durationMinutes: 25, taxonomy: [bookshop]};
  assert.equal(matchesPlaceQuery(base, 'library'), false);
  assert.equal(matchesPlaceQuery({...base, name: 'Public Library', category: 'culture', taxonomy: [library, bookshop]}, 'bookstore', [bookshop]), false);
  assert.equal(matchesPlaceQuery(base, 'bookstore', [bookshop]), true);
  const misleadingCafe = {...base, name: 'Library Bookshop Café', category: 'food' as const, taxonomy: [cafe]};
  assert.equal(matchesPlaceQuery(misleadingCafe, 'library', [cafe]), false);
  assert.equal(matchesPlaceQuery(misleadingCafe, 'bookshop', [cafe]), false);
});
