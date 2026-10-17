import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_PLACE_IMAGES, placeImages} from '../src/shared/place-images.js';
import {qlooImages} from '../src/server/providers/media.js';
import {enrichSelectedPlaces} from '../src/server/providers/qloo.js';
import {publicTrip} from '../src/server/services/shared-trips.js';
import {sampleArtists, samplePlaces, sampleVenues} from '../src/server/data/catalog.js';
import {checkPlan} from '../src/server/services/planner.js';
import type {Place, PlaceImage} from '../src/shared/types.js';

const image = (name: string): PlaceImage => ({url: `https://images.qloo.com/i/${name}.jpg`, alt: 'A public place', attribution: [{name: 'Qloo', url: 'https://www.qloo.com/'}]});

test('photo sets preserve the cover, cap payload growth and count size variants as one image', () => {
  const cover = image('primary-420x-auto');
  const photos = placeImages({image: cover, images: [image('primary-840x-auto'), image('second'), image('second'), ...Array.from({length: 20}, (_, index) => image(`extra-${index}`))]});
  assert.equal(photos[0], cover); assert.equal(photos.length, MAX_PLACE_IMAGES);
  assert.deepEqual(photos.slice(0, 2).map(photo => photo.url), [cover.url, image('second').url]);
  assert.deepEqual(placeImages({image: cover}), [cover], 'Old trips with one image remain supported');
  assert.deepEqual(placeImages({}), []);
  assert.equal(placeImages({images: [{...image('a'), url: 'https://images.qloo.com/i/a.jpg?size=small'}, {...image('a'), url: 'https://images.qloo.com/i/a.jpg?size=large'}]}).length, 1);
});

test('every extra provider image stays behind the same strict public CDN boundary as the cover', () => {
  const unsafe = ['http://images.qloo.com/i/a.jpg', 'https://api.qloo.com/private?key=secret', 'https://images.qloo.com/i/a.jpg?key=secret',
    'https://images.qloo.com/i/a.jpg#secret', 'https://images.qloo.com.attacker.example/i/a.jpg', 'https://user:pass@images.qloo.com/i/a.jpg',
    'https://images.qloo.com:8443/i/a.jpg', 'https://images.qloo.com/private.jpg'];
  const photos = qlooImages({properties: {image: image('cover'), images: [...unsafe.map(url => ({url})), image('allowed')]}}, '<b>Place</b>');
  assert.deepEqual(photos.map(photo => photo.url), [image('cover').url, image('allowed').url]);
  assert.equal(photos[1]!.alt, 'Place'); assert.equal(photos[1]!.attribution?.[0]?.name, 'Qloo');
  assert.deepEqual(qlooImages({properties: {images: 'not-an-array'}}, 'Place'), []);
});

test('existing optional entity enrichment keeps distinct real photos without another provider request', async t => {
  const original: Place = {...samplePlaces[0]!, id: '88888888-8888-4888-8888-888888888888', image: image('cover-420x-auto')};
  const fetch = t.mock.method(globalThis, 'fetch', async (resource: Parameters<typeof globalThis.fetch>[0]) => {
    assert.equal(new URL(String(resource)).pathname, '/entities');
    return new Response(JSON.stringify({results: [{entity_id: original.id, subtype: 'urn:entity:place', name: original.name,
      properties: {image: image('second'), images: [image('cover-840x-auto'), image('third')]}}]}), {headers: {'Content-Type': 'application/json'}});
  });
  const result = await enrichSelectedPlaces({qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'photo-gallery-boundaries-test'}, sampleArtists[0]!, sampleVenues[0]!, [original]);
  assert.equal(fetch.mock.calls.length, 1);
  assert.deepEqual(result[0]!.images?.map(photo => photo.url), [original.image!.url, image('second').url, image('third').url]);
  assert.equal(result[0]!.image?.url, original.image?.url);
  assert.equal(original.images, undefined, 'Optional enrichment does not mutate earlier saved versions');
});

test('friend snapshots include only bounded public gallery fields and preserve source credit', async () => {
  const venue = sampleVenues[0]!, selected = samplePlaces.filter(place => place.category !== 'food').slice(0, 2);
  const checked = await checkPlan({ids: selected.map(place => place.id), input: {artist: sampleArtists[0]!, venueId: venue.id,
    date: '2026-10-22', showTime: '19:00', durationMinutes: 480, startingPoint: 'Private hotel'}, venue, candidates: selected, mode: 'sample'});
  assert.ok(checked.itinerary);
  const plan = checked.itinerary;
  plan.stops[0]!.image = image('cover');
  plan.stops[0]!.images = [{...image('extra'), privateNote: 'Private hotel', attribution: [{name: 'Qloo', url: 'https://www.qloo.com/', privateNote: 'Private hotel'}]}, ...Array.from({length: 12}, (_, index) => image(`other-${index}`))] as PlaceImage[];
  const snapshot = publicTrip(plan, 'a'.repeat(43));
  assert.equal(snapshot.stops[0]!.images?.length, MAX_PLACE_IMAGES);
  assert.deepEqual(snapshot.stops[0]!.images?.[1], image('extra'));
  assert.ok(!JSON.stringify(snapshot.stops[0]!.images).includes('Private hotel'));
  assert.equal(snapshot.stops[0]!.images?.[1]?.attribution?.[0]?.name, 'Qloo');
});
