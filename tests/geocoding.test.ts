import assert from 'node:assert/strict';
import test from 'node:test';
import type { Venue } from '../src/shared/types.js';
import { geocodeStartingLocation, lookupStartingArea, matchesStartingCity } from '../src/server/providers/geocoding.js';

const venue: Venue = {id: 'venue', name: 'Bowery Ballroom', city: 'New York', address: '6 Delancey St, New York, NY 10002', coordinates: {latitude: 40.72049, longitude: -73.99337}, website: '', timezone: 'America/New_York'};
const config = {qlooApiKey: 'test-only-geocoding', qlooApiUrl: 'https://api.qloo.com'};
function locality(id: number, name: string, latitude = 40.72347, longitude = -74.000865) {
  return {entity_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, name, subtype: 'urn:entity:locality', type: 'urn:entity:locality', types: ['urn:entity:locality'], location: {lat: latitude, lon: longitude}, properties: {geocode: {city: 'New York'}, ancestors: [{place: 'suburb', name: 'Manhattan'}, {place: 'city', name: 'New York'}, {place: 'state', name: 'New York'}, {place: 'country', name: 'United States'}]}};
}
async function withResults(results: unknown[], run: (calls: URL[]) => Promise<void>) {
  const original = globalThis.fetch, calls: URL[] = [];
  globalThis.fetch = async input => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify({results}), {headers: {'Content-Type': 'application/json'}});
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}

test('Qloo neighborhood resolution matches the requested area and marks its center approximate', async () => {
  await withResults([locality(1, 'SoHo')], async calls => {
    const result = await geocodeStartingLocation(config, 'SoHo New York', 'neighborhood', venue);
    assert.equal(result?.name, 'SoHo');
    assert.deepEqual(result?.coordinates, {latitude: 40.72347, longitude: -74.000865});
    assert.equal(result?.approximate, true);
    assert.equal(result?.source?.title, 'Qloo locality data');
    assert.equal(calls[0]?.origin, 'https://api.qloo.com');
    assert.equal(calls[0]?.searchParams.get('types'), 'urn:entity:locality');
  });
});

test('administrative suffixes preserve the exact area match without accepting conflicting cities or unrelated names', async () => {
  await withResults([locality(8, 'SoHo')], async () => {
    assert.equal((await geocodeStartingLocation(config, 'SoHo, Manhattan, New York, NY', 'neighborhood', venue))?.name, 'SoHo');
    assert.equal((await geocodeStartingLocation(config, 'SoHo New York NY', 'neighborhood', venue))?.name, 'SoHo');
    assert.equal((await geocodeStartingLocation(config, 'SoHo Manhattan New York', 'neighborhood', venue))?.name, 'SoHo');
    assert.equal((await geocodeStartingLocation(config, 'SoHo, New York City', 'neighborhood', venue))?.name, 'SoHo');
    assert.equal(await geocodeStartingLocation(config, 'SoHo, Boston', 'neighborhood', venue), undefined);
    assert.equal(await geocodeStartingLocation(config, 'SoHo, Boston City', 'neighborhood', venue), undefined);
    assert.equal(await geocodeStartingLocation(config, 'SoHo City, New York', 'neighborhood', venue), undefined);
    assert.equal(await geocodeStartingLocation(config, 'Somewhere else, New York, NY', 'neighborhood', venue), undefined);
  });
});

test('distant duplicate area names require clarification instead of choosing the first', async () => {
  await withResults([locality(2, 'West Village'), locality(3, 'West Village', 40.73)], async () => {
    assert.equal(await geocodeStartingLocation(config, 'West Village', 'neighborhood', venue), undefined);
  });
});

test('remote, invalid, and unrelated locality results never become a starting point', async () => {
  await withResults([locality(4, 'Nearby Area', 25.57, -103.50), locality(5, 'Nearby Area', 91), locality(6, 'Nearby Area', 40.82), locality(7, 'Unrelated Area')], async () => {
    assert.equal(await geocodeStartingLocation(config, 'Nearby Area', 'neighborhood', venue), undefined);
  });
});

test('area resolution does not turn an address or arbitrary URL into a locality lookup', async () => {
  await withResults([], async calls => {
    assert.equal(await geocodeStartingLocation(config, '126 Crosby Street', 'address', venue), undefined);
    assert.equal(await geocodeStartingLocation(config, 'https://example.com', 'neighborhood', venue), undefined);
    assert.equal(calls.length, 0);
  });
});


test('conversational locality boundaries preserve complete names and reject conflicting administrative context', async () => {
  await withResults([locality(9, 'SoHo')], async () => {
    for (const query of ['around SoHo area, New York, NY', 'in the SoHo neighborhood New York', 'starting near SoHo, Manhattan, New York']) {
      assert.equal((await geocodeStartingLocation(config, query, 'neighborhood', venue))?.name, 'SoHo');
    }
    assert.equal(await geocodeStartingLocation(config, 'around SoHo area, Boston', 'neighborhood', venue), undefined);
    assert.equal(await geocodeStartingLocation(config, 'around North SoHo area, New York', 'neighborhood', venue), undefined);
  });
  const gardenVenue = {...venue, city: 'New Orleans', address: '1 Royal St, New Orleans, LA', coordinates: {latitude: 29.9296, longitude: -90.0924}};
  const garden = {...locality(10, 'Garden District', 29.93, -90.091), properties: {ancestors: [{place: 'city', name: 'New Orleans'}, {place: 'state', name: 'Louisiana'}]}};
  await withResults([garden], async () => {
    assert.equal((await geocodeStartingLocation(config, 'around the Garden District area, New Orleans', 'neighborhood', gardenVenue))?.name, 'Garden District');
  });
});


test('provider administrative city conflicts remain significant even within the walking radius',async()=>{
 const conflict={...locality(11,'SoHo'),properties:{place:'neighbourhood',ancestors:[{place:'city',name:'Hoboken'}]}};
 await withResults([conflict],async()=>{assert.equal(await geocodeStartingLocation({...config,qlooApiKey:'nearby-conflicting-city'},'SoHo','neighborhood',venue),undefined);});
 const alias={...locality(12,'SoHo'),properties:{place:'neighbourhood',ancestors:[{place:'city',name:'NYC'},{place:'state',name:'N.Y.'}]}};
 await withResults([alias],async()=>{assert.equal((await geocodeStartingLocation({...config,qlooApiKey:'provider-city-alias'},'SoHo','neighborhood',venue))?.name,'SoHo');});
});


test('an explicit different city cannot borrow street-name words or a fragment of the venue city', () => {
  const missingCity = {address: '1 Boston Road, New York, NY', city: 'Selected location'};
  assert.equal(matchesStartingCity(missingCity, 'Boston', venue), false);
  assert.equal(matchesStartingCity(missingCity, 'York', venue), false);
  assert.equal(matchesStartingCity(missingCity, 'New York', venue), true);
  assert.equal(matchesStartingCity({address: '1 Example St, Boston, MA', city: 'Boston'}, 'Boston', venue), true);
});


const bowl: Venue = {...venue, name: 'Hollywood Bowl', city: 'Los Angeles', address: '2301 Highland Ave, Los Angeles, CA 90068', coordinates: {latitude: 34.112224, longitude: -118.3391279}};
function municipality(id: number, name: string, place = 'city', latitude = 34.078530378534744, longitude = -118.40214505107477) {
  return {...locality(id, name, latitude, longitude), properties: {place, ancestors: [{place: 'county', name: 'Los Angeles'}, {place: 'state', name: 'California'}, {place: 'country', name: 'United States of America'}]}};
}

test('an exact adjacent municipality is a verified area rather than a neighborhood forced into the venue city', async () => {
  await withResults([municipality(50, 'Beverly Hills')], async calls => {
    const result = await lookupStartingArea({...config, qlooApiKey: 'municipality-adjacent'}, 'Beverly Hills', bowl);
    assert.equal(result.status, 'found');
    if (result.status !== 'found') return;
    assert.equal(result.location.name, 'Beverly Hills');
    assert.deepEqual(result.location.coordinates, {latitude: 34.078530378534744, longitude: -118.40214505107477});
    assert.equal(result.location.approximate, true);
    assert.match(result.location.address, /California/);
    assert.equal('localityKind' in result.location, false, 'Internal municipality evidence is not client trip data');
    assert.equal(calls.length, 1);
  });
  await withResults([municipality(51, 'Beverly Hills')], async () => {
    assert.equal((await lookupStartingArea({...config, qlooApiKey: 'municipality-own-city'}, 'Beverly Hills', bowl, 'Beverly Hills')).status, 'found');
  });
});

test('small municipalities retain real provider coordinates while unsupported administrative regions cannot become starts', async () => {
  for (const kind of ['town', 'village', 'municipality']) await withResults([municipality(52, 'Smallville', kind)], async () => {
    assert.equal((await lookupStartingArea({...config, qlooApiKey: `municipality-kind-${kind}`}, 'Smallville', bowl)).status, 'found');
  });
  for (const kind of ['county', 'state', 'country', 'region']) await withResults([municipality(53, 'Smallville', kind)], async () => {
    assert.equal((await lookupStartingArea({...config, qlooApiKey: `municipality-rejected-${kind}`}, 'Smallville', bowl)).status, 'not_found');
  });
});

test('municipality matching cannot ignore an explicitly conflicting city or borrow only a fragment of a proper name', async () => {
  await withResults([municipality(54, 'Beverly Hills')], async () => {
    const provider = {...config, qlooApiKey: 'municipality-city-conflict'};
    assert.equal((await lookupStartingArea(provider, 'Beverly Hills', bowl, 'Boston')).status, 'not_found');
    assert.equal((await lookupStartingArea(provider, 'Hills', bowl)).status, 'not_found');
  });
  const neighborhood = {...municipality(55, 'The Flats', 'neighbourhood'), properties: {place: 'neighbourhood', ancestors: [{place: 'city', name: 'Beverly Hills'}, {place: 'state', name: 'California'}]}};
  await withResults([neighborhood], async () => {
    assert.equal((await lookupStartingArea({...config, qlooApiKey: 'adjacent-neighborhood-strict'}, 'The Flats', bowl)).status, 'not_found');
    assert.equal((await lookupStartingArea({...config, qlooApiKey: 'adjacent-neighborhood-named-city'}, 'The Flats', bowl, 'Beverly Hills')).status, 'found');
  });
});

test('municipality support preserves the existing range and ambiguity boundaries', async () => {
  await withResults([municipality(56, 'Beverly Hills', 'city', 34.3, -118.4)], async () => {
    assert.equal((await lookupStartingArea({...config, qlooApiKey: 'municipality-range'}, 'Beverly Hills', bowl)).status, 'out_of_range');
  });
  await withResults([municipality(57, 'Beverly Hills'), municipality(58, 'Beverly Hills', 'city', 34.09, -118.4)], async () => {
    assert.equal((await lookupStartingArea({...config, qlooApiKey: 'municipality-ambiguity'}, 'Beverly Hills', bowl)).status, 'ambiguous');
  });
});

test('a neighborhood supplied under a town keeps its structured municipality constraint', async () => {
  const neighborhood = {...municipality(59, 'Old Quarter', 'neighbourhood'), properties: {place: 'neighbourhood', ancestors: [{place: 'town', name: 'Beverly Hills'}, {place: 'county', name: 'Los Angeles'}]}};
  await withResults([neighborhood], async () => {
    assert.equal((await lookupStartingArea({...config, qlooApiKey: 'town-neighborhood-city-conflict'}, 'Old Quarter', bowl)).status, 'not_found');
    assert.equal((await lookupStartingArea({...config, qlooApiKey: 'town-neighborhood-own-city'}, 'Old Quarter', bowl, 'Beverly Hills')).status, 'found');
  });
});
