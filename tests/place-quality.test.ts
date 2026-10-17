import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place } from '../src/shared/types.js';
import { culturalQuality, isCulturallyEligible, selectCulturalPlaces } from '../src/server/services/cultural-quality.js';
import { googlePlaceId, qlooImage } from '../src/server/providers/media.js';
const base: Place = {id: '1', name: 'Local cafe', category: 'food', address: '', coordinates: {latitude: 40, longitude: -74}, description: '', durationMinutes: 25};

test('generic chains and generic retail cannot fill cultural recommendations', () => {
  for (const name of ["McDonald's", 'McDonalds - Broadway', 'Starbucks Reserve', 'STARBUCKS COFFEE', '7-Eleven', 'H&M', 'CVS Pharmacy', 'Urban Outfitters', 'Urban Outfitters - Herald Square', 'Hard Rock Cafe', 'Hard Rock Café Times Square']) {
    assert.equal(isCulturallyEligible({...base, name}), false, name);
  }
  for (const name of ['Apple Tree Gallery', 'Target Margin Theater', 'Gap Gallery', 'Subway Inn', 'Hard Rock Records', 'Hard Rock Music Museum']) assert.equal(isCulturallyEligible({...base, name}), true, name);
  assert.equal(isCulturallyEligible({...base, name: 'Corner Kitchen', taxonomy: ['urn:tag:genre:place:fast_food_restaurant']}), true);
  const bookstore = {...base, id: '2', name: 'Local Books', category: 'shop' as const, taxonomy: ['urn:tag:genre:place:bookstore'], affinity: .4};
  assert.deepEqual(selectCulturalPlaces([{...base, affinity: .99}, {...base, name: 'Starbucks', affinity: 1}, bookstore]).map(p => p.id), ['2', '1']);
});
test('tour booking offices are excluded without excluding genuine visitor attractions', () => {
  const attraction = 'urn:tag:genre:place:tourist_attraction';
  for (const service of ['tour_operator', 'bus_tour_agency', 'travel_agency', 'tour_agency', 'sightseeing_tour_agency']) {
    assert.equal(isCulturallyEligible({...base, name: 'A tour booking office', category: 'culture',
      taxonomy: [attraction, `urn:tag:category:place:${service}`]}), false, service);
  }
  for (const [name, taxonomy] of [
    ['Neighborhood Museum', [attraction, 'urn:tag:genre:place:museum']],
    ['Historic Landmark', [attraction, 'urn:tag:genre:place:landmark']],
    ['Local Art Gallery', ['urn:tag:genre:place:art_gallery']],
    ['Local Books', ['urn:tag:genre:place:bookstore']],
    ['A visitor attraction', [attraction]],
  ] as const) assert.equal(isCulturallyEligible({...base, name, taxonomy: [...taxonomy]}), true, name);
});
test('public media rejects API URLs and extracts the actual Google Place ID', () => {
  assert.equal(qlooImage({properties: {image: {url: 'https://api.qloo.com/private?key=secret'}}}, 'Place'), undefined);
  assert.equal(qlooImage({properties: {image: {url: 'https://images.qloo.com/i/p.jpg?key=secret'}}}, 'Place'), undefined);
  assert.ok(qlooImage({properties: {image: {url: 'https://images.qloo.com/i/p.jpg'}}}, 'Place'));
  assert.equal(googlePlaceId({properties: {external: {google_place: {id: 'not-the-place-id', place_id: 'ChIJLQUUOYZZwokR1BfSFbM-XB4'}}}}), 'ChIJLQUUOYZZwokR1BfSFbM-XB4');
});


test('tourist-attraction taxonomy alone does not claim the cultural significance of a museum or historic landmark', () => {
  const attraction = {...base, id: 'photo-attraction', name: 'An interactive photo attraction', category: 'culture' as const,
    taxonomy: ['urn:tag:genre:place:tourist_attraction'], affinity: .99};
  const museum = {...attraction, id: 'local-museum', name: 'City History Museum', affinity: .2,
    taxonomy: ['urn:tag:genre:place:tourist_attraction', 'urn:tag:genre:place:museum']};
  const landmark = {...attraction, id: 'landmark', taxonomy: ['urn:tag:genre:place:landmark']};
  assert.equal(isCulturallyEligible(attraction), true, 'A real attraction remains available rather than being arbitrarily excluded');
  assert.ok(culturalQuality(attraction) < culturalQuality(museum));
  assert.ok(culturalQuality(attraction) < culturalQuality(landmark));
  assert.deepEqual(selectCulturalPlaces([attraction, museum]).map(place => place.id), ['local-museum', 'photo-attraction']);
});
