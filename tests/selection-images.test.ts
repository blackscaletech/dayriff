import assert from 'node:assert/strict';
import test from 'node:test';
import type {PlanInput} from '../src/shared/types.js';
import {normalizeArtist, normalizeVenue, searchArtists} from '../src/server/providers/qloo.js';
import {resolveSelectedEntities} from '../src/server/providers/selected-entities.js';
import {planInputSchema} from '../src/server/validation.js';

const artistId = '77777777-7777-4777-8777-777777777771';
const venueId = '77777777-7777-4777-8777-777777777772';
const artistPhoto = 'https://images.qloo.com/i/artist.jpg';
const venuePhoto = 'https://images.qloo.com/i/venue.jpg';
const artistEntity = {entity_id: artistId, name: 'Selected Artist', subtype: 'urn:entity:artist', properties: {description: 'Verified artist detail', image: {url: artistPhoto}}};
const venueEntity = {entity_id: venueId, name: 'Selected Venue', subtype: 'urn:entity:place', location: {lat: 40.75, lon: -73.99},
  tags: [{id: 'urn:tag:category:place:concert_hall'}], properties: {address: 'New York, NY', geocode: {city: 'New York'}, image: {url: venuePhoto}}};
const config = {qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'selection-images-test'};
const input: PlanInput = {artist: {id: artistId, name: 'Untrusted name', image: {url: 'https://untrusted.example/photo', alt: 'Untrusted image'}}, venueId,
  date: '2026-10-21', showTime: '19:00', durationMinutes: 180, startingPoint: 'Near the venue'};
const json = (results: unknown[]) => new Response(JSON.stringify({results}), {status: 200, headers: {'Content-Type': 'application/json'}});

test('artist search includes trusted optional media without an additional provider request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('types'), 'urn:entity:artist');
    calls++;
    return json([artistEntity]);
  };
  try {
    const artists = await searchArtists(config, 'Selected Artist');
    assert.equal(calls, 1);
    assert.equal(artists[0]?.image?.url, artistPhoto);
    assert.equal(artists[0]?.image?.alt, artistEntity.name);
    assert.equal(artists[0]?.image?.attribution?.[0]?.name, 'Qloo');
  } finally {globalThis.fetch = original;}
});

test('artist and venue metadata share the public CDN media boundary', () => {
  assert.equal(normalizeVenue(venueEntity)?.image?.url, venuePhoto);
  assert.equal(normalizeArtist({...artistEntity, properties: {}})?.image, undefined);
  assert.equal(normalizeVenue({...venueEntity, properties: {}})?.image, undefined);
  for (const url of [
    'https://api.qloo.com/private?key=secret', 'https://images.qloo.com/i/photo.jpg?key=secret',
    'https://images.qloo.com/i/photo.jpg#secret', 'https://images.qloo.com.attacker.example/i/photo.jpg',
    'https://user:password@images.qloo.com/i/photo.jpg', 'http://images.qloo.com/i/photo.jpg',
  ]) {
    assert.equal(normalizeArtist({...artistEntity, properties: {image: {url}}})?.image, undefined, url);
    assert.equal(normalizeVenue({...venueEntity, properties: {image: {url}}})?.image, undefined, url);
  }
});

test('canonical selections retain provider media, including expired-session recovery, without trusting submitted media', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async resource => {
    const url = new URL(String(resource));
    assert.equal(url.pathname, '/entities');
    calls++;
    return json([artistEntity, venueEntity]);
  };
  try {
    const selected = await resolveSelectedEntities(config, input, {artists: [], venues: []});
    assert.equal(calls, 1, 'Both identities and photos use the existing single entity lookup');
    assert.equal(selected.artist.name, artistEntity.name);
    assert.equal(selected.artist.detail, artistEntity.properties.description);
    assert.equal(selected.artist.image?.url, artistPhoto);
    assert.equal(selected.venue.image?.url, venuePhoto);
    const cached = await resolveSelectedEntities(config, input, {artists: [selected.artist], venues: [selected.venue]});
    assert.equal(calls, 1, 'Already verified selections require no media enrichment call');
    assert.deepEqual(cached, selected);
  } finally {globalThis.fetch = original;}
});

test('plan submission strips client image data while keeping the rest of its strict input boundary', () => {
  const parsed = planInputSchema.parse(input);
  assert.equal(Object.hasOwn(parsed.artist, 'image'), false);
  assert.equal(parsed.artist.id, artistId);
  assert.equal(planInputSchema.safeParse({...input, artist: {...input.artist, coordinates: {latitude: 1, longitude: 1}}}).success, false);
});
