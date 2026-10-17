import assert from 'node:assert/strict';
import test from 'node:test';
import type { Venue } from '../src/shared/types.js';
import type { ServerConfig } from '../src/server/config.js';
import { resolveStartingLocation } from '../src/server/providers/starting-location.js';
import { ServiceError } from '../src/server/providers/http.js';

const venue: Venue = {id: 'venue', name: 'Bowery Ballroom', city: 'New York', address: '6 Delancey St, New York, NY 10002', coordinates: {latitude: 40.72049, longitude: -73.99337}, website: '', timezone: 'America/New_York'};
let sequence = 0;
function entity(index: number, name: string, address: string, latitude = 40.721) {
  return {entity_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name, subtype: 'urn:entity:place',
    location: {lat: latitude, lon: -73.991}, properties: {address, geocode: {city: 'New York'}}};
}
async function withInterpretation(query: string, kind: 'address' | 'place' | 'neighborhood' | 'clarify', results: unknown[] | ((url: URL) => Response), run: (config: ServerConfig, requests: {startingTexts: string[]; qloo: URL[]}) => Promise<void>, city: string | null = venue.city) {
  const config: ServerConfig = {mode: 'live', port: 3000, host: '127.0.0.1', production: false,
    qlooApiKey: `starting-boundary-${++sequence}`, qlooApiUrl: 'https://api.qloo.com', openaiApiKey: 'starting-boundary-only', openaiModel: 'gpt-6-luna', openaiReasoningEffort: 'medium',
    cookieSecret: 'starting-boundary-only', maxDailyPlans: 100, maxDailyLookups: 2000};
  const original = globalThis.fetch, requests: {startingTexts: string[]; qloo: URL[]} = {startingTexts: [], qloo: []};
  globalThis.fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.hostname === 'api.openai.com') {
      const body = JSON.parse(String(init?.body));
      requests.startingTexts.push(JSON.parse(body.input[0].content).startingText);
      return new Response(JSON.stringify({output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify({kind, query, city, clarification: kind === 'clarify' ? 'Which hotel or address are you starting from?' : null})}]}]}));
    }
    assert.equal(url.origin, 'https://api.qloo.com');
    assert.equal(url.pathname, '/search');
    requests.qloo.push(url);
    if (typeof results === 'function') return results(url);
    const resultType = kind === 'neighborhood' ? 'urn:entity:locality' : 'urn:entity:place';
    return new Response(JSON.stringify({results: url.searchParams.get('types') === resultType ? results : []}));
  };
  try { await run(config, requests); } finally { globalThis.fetch = original; }
}
const needsDetails = (error: unknown) => error instanceof ServiceError && ['START_NEEDS_DETAILS', 'START_NOT_FOUND', 'START_AMBIGUOUS', 'START_OUT_OF_RANGE'].includes(error.code);
const errorCode = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

test('single-digit house numbers cannot resolve to another street number', async () => {
  await withInterpretation('1 Broadway, New York', 'address', [entity(1, 'Wrong building', '11 Broadway, New York, NY')], async config => {
    await assert.rejects(resolveStartingLocation(config, '1 Broadway', venue), needsDetails);
  });
  await withInterpretation('1 Broadway, New York', 'address', [entity(2, 'Correct building', '1 Broadway, New York, NY')], async config => {
    assert.equal((await resolveStartingLocation(config, '1 Broadway', venue))?.address, '1 Broadway, New York, NY');
  });
});

test('house numbers must match the building rather than a suite number elsewhere in its address', async () => {
  await withInterpretation('126 Crosby Street, New York', 'address', [entity(3, 'Wrong building', '999 Crosby St, Suite 126, New York, NY')], async config => {
    await assert.rejects(resolveStartingLocation(config, '126 Crosby Street', venue), needsDetails);
  });
});

test('street directionals remain significant and full words match their abbreviations', async () => {
  for (const [direction, opposite] of [['East', 'West'], ['West', 'East'], ['North', 'South'], ['South', 'North']]) {
    const query = `1 ${direction} 4th Street, New York`;
    await withInterpretation(query, 'address', [entity(4, 'Opposite direction', `1 ${opposite} 4th St, New York, NY`)], async config => {
      await assert.rejects(resolveStartingLocation(config, query, venue), needsDetails);
    });
    await withInterpretation(query, 'address', [entity(5, 'Correct direction', `1 ${direction![0]} 4th St, New York, NY`)], async config => {
      assert.ok(await resolveStartingLocation(config, query, venue));
    });
  }
});

test('a third distant same-name match still requires clarification after two nearby duplicate results', async () => {
  const places = [entity(6, 'Corner Cafe', '10 Example St, New York', 40.721), entity(7, 'Corner Cafe', '10 Example St, New York', 40.7211), entity(8, 'Corner Cafe', '100 Other St, New York', 40.74)];
  await withInterpretation('Corner Cafe, New York', 'place', places, async config => {
    await assert.rejects(resolveStartingLocation(config, 'Corner Cafe', venue), needsDetails);
  });
  await withInterpretation('Corner Cafe, New York', 'place', places.slice(0, 2), async config => {
    assert.equal((await resolveStartingLocation(config, 'Corner Cafe', venue))?.name, 'Corner Cafe');
  });
});

test('direction words in a business name do not become an ignored one-letter token', async () => {
  await withInterpretation('West Cafe, New York', 'place', [entity(9, 'East Cafe', '1 Example St, New York')], async config => {
    await assert.rejects(resolveStartingLocation(config, 'West Cafe', venue), needsDetails);
  });
});


test('informal misspelled starts use the interpreted area and provider coordinates while ambiguity asks for detail', async () => {
  const soho = {entity_id: '00000000-0000-4000-8000-000000000010', name: 'SoHo', type: 'urn:entity:locality',
    location: {lat: 40.72347, lon: -74.000865}, properties: {ancestors: [{place: 'suburb', name: 'Manhattan'}, {place: 'city', name: 'New York'}, {place: 'state', name: 'New York'}]}};
  await withInterpretation('SoHo', 'neighborhood', [soho], async (config, requests) => {
    const start = await resolveStartingLocation(config, 'aeround soho area', venue);
    assert.deepEqual(requests.startingTexts, ['aeround soho area']);
    assert.equal(requests.qloo.length, 1);
    assert.equal(requests.qloo[0]?.searchParams.get('query'), 'SoHo');
    assert.equal(start?.name, 'SoHo');
    assert.deepEqual(start?.coordinates, {latitude: 40.72347, longitude: -74.000865});
    assert.equal(start?.approximate, true);
    assert.equal(start?.source?.title, 'Qloo locality data');
  });
  await withInterpretation('', 'clarify', [], async (config, requests) => {
    await assert.rejects(resolveStartingLocation(config, 'my hotel nearby', venue), needsDetails);
    assert.deepEqual(requests.startingTexts, ['my hotel nearby']);
    assert.equal(requests.qloo.length, 0);
  });
});


function area(id: number, name: string, latitude = 40.71879, longitude = -74.00895, city = 'New York') {
 return {entity_id:`00000000-0000-4000-8000-${String(id).padStart(12,'0')}`,name,type:'urn:entity:locality',location:{lat:latitude,lon:longitude},properties:{place:'neighbourhood',ancestors:[{place:'borough',name:'Manhattan'},{place:'city',name:city},{place:'state',name:'N.Y.'}]}};
}
function results(entities:unknown[]){return new Response(JSON.stringify({results:entities}),{headers:{'Content-Type':'application/json'}});}

test('canonical neighborhood lookup is separate from city context when a qualified search hides the real area',async()=>{
 await withInterpretation('TriBeCa','neighborhood',url=>results(url.searchParams.get('query')==='TriBeCa'?[area(11,'TriBeCa')]:[]),async(config,requests)=>{
  const start=await resolveStartingLocation(config,'around tribeca',venue);
  assert.equal(start?.name,'TriBeCa');assert.deepEqual(start?.coordinates,{latitude:40.71879,longitude:-74.00895});assert.equal(start?.approximate,true);
  assert.equal(requests.qloo.length,1);assert.equal(requests.qloo[0]?.searchParams.get('query'),'TriBeCa');assert.equal(requests.qloo[0]?.searchParams.get('take'),'8');assert.equal(requests.qloo[0]?.searchParams.get('filter.location'),`${venue.coordinates.latitude},${venue.coordinates.longitude}`);
 });
 const elsewhere={...venue,city:'New Orleans',address:'1 Royal St, New Orleans, LA',coordinates:{latitude:29.9296,longitude:-90.0924}};
 await withInterpretation('Garden District','neighborhood',[area(12,'Garden District',29.93,-90.091,'New Orleans')],async config=>{
  assert.equal((await resolveStartingLocation(config,'around the Garden District',elsewhere))?.name,'Garden District');
 },'New Orleans');
});

test('starting lookup preserves retryable provider failures and recovers through a bounded alternate query',async()=>{
 await withInterpretation('TriBeCa','neighborhood',()=>new Response('{}',{status:429}),async(config,requests)=>{
  await assert.rejects(resolveStartingLocation(config,'around tribeca',venue),errorCode('START_UNAVAILABLE'));assert.equal(new Set(requests.qloo.map(url => url.href)).size,2);assert.ok(requests.qloo.length <= 4);
 });
 await withInterpretation('TriBeCa','neighborhood',url=>url.searchParams.get('query')==='TriBeCa'?new Response('{}',{status:503}):results([area(13,'TriBeCa')]),async(config,requests)=>{
  assert.equal((await resolveStartingLocation(config,'around tribeca',venue))?.name,'TriBeCa');assert.equal(requests.qloo.length,2);
 });
 await withInterpretation('Far Neighborhood','neighborhood',url=>url.searchParams.has('filter.location')?new Response('{}',{status:429}):results([area(20,'Far Neighborhood',40.9)]),async config=>{
  await assert.rejects(resolveStartingLocation(config,'Far Neighborhood',venue),errorCode('START_UNAVAILABLE'),'An incomplete lookup must not tell the user to move a potentially valid origin');
 });
 await withInterpretation('Corner Cafe','place',()=>new Response('{}',{status:503}),async config=>{
  await assert.rejects(resolveStartingLocation(config,'Corner Cafe',venue),errorCode('START_UNAVAILABLE'));
 });
});

test('verified ambiguity, missing matches and walking range have distinct outcomes without a venue fallback',async()=>{
 await withInterpretation('TriBeCa','neighborhood',[area(14,'TriBeCa'),area(15,'TriBeCa',40.724)],async config=>{
  await assert.rejects(resolveStartingLocation(config,'around tribeca',venue),errorCode('START_AMBIGUOUS'));
 });
 await withInterpretation('Unknown Area','neighborhood',[],async config=>{
  await assert.rejects(resolveStartingLocation(config,'Unknown Area',venue),errorCode('START_NOT_FOUND'));
 });
 await withInterpretation('Far Neighborhood','neighborhood',[area(16,'Far Neighborhood',40.9)],async config=>{
  await assert.rejects(resolveStartingLocation(config,'Far Neighborhood',venue),errorCode('START_OUT_OF_RANGE'));
 });
});

test('proper business names retain city and area words while conflicting declared cities remain significant',async()=>{
 await withInterpretation('Greenwich Area','place',[entity(17,'Greenwich Area','1 Example St, New York')],async(config,requests)=>{
  assert.equal((await resolveStartingLocation(config,'Greenwich Area',venue))?.name,'Greenwich Area');assert.equal(requests.qloo[0]?.searchParams.get('query'),'Greenwich Area');
 });
 await withInterpretation('New York Public Library','place',[entity(18,'Brooklyn Public Library','1 Example St, New York')],async config=>{
  await assert.rejects(resolveStartingLocation(config,'New York Public Library',venue),errorCode('START_NOT_FOUND'));
 });
 const boston={...venue,city:'Boston',address:'1 Example St, Boston, MA',coordinates:{latitude:42.36,longitude:-71.06}};
 const cafe={...entity(19,'Corner Cafe','1 Example St, Boston, MA'),location:{lat:42.36,lon:-71.06},properties:{address:'1 Example St, Boston, MA',geocode:{city:'Boston'}}};
 await withInterpretation('Corner Cafe','place',[cafe],async config=>{
  await assert.rejects(resolveStartingLocation(config,'Corner Cafe in NYC',boston),errorCode('START_NOT_FOUND'));
 },'New York');
});

// Synthetic area/anchor fixtures exercise the provider shape without publishing API payloads.
function areaAnchor(id: number, category: string, options: {name?: string; city?: string; latitude?: number; commercial?: boolean} = {}) {
  return {...entity(id, options.name ?? 'Market Quarter', '1 Market Walk, New York, NY', options.latitude ?? 40.721),
    properties: {address: '1 Market Walk, New York, NY', geocode: {city: options.city ?? 'New York'}},
    tags: [{type: 'urn:tag:category:place', name: 'Public anchor', value: `urn:tag:category:place:${category}`},
      ...(options.commercial ? [{type: 'urn:tag:genre:place', name: 'Restaurant', value: 'urn:tag:genre:place:restaurant'}] : [])]};
}
function areaOrAnchors(anchors: unknown[]) {
  return (url: URL) => results(url.searchParams.get('types') === 'urn:entity:place' ? anchors : [area(30, 'Unrelated Quarter')]);
}

test('missing locality coverage uses one exact-name public area anchor and preserves provider coordinates and provenance', async () => {
  await withInterpretation('Market Quarter', 'neighborhood', areaOrAnchors([
    areaAnchor(31, 'tourist_attraction'), areaAnchor(32, 'subway_station', {latitude: 40.7212}),
  ]), async (config, requests) => {
    const start = await resolveStartingLocation(config, 'around Market Quarter', venue);
    assert.equal(start?.name, 'Market Quarter');
    assert.deepEqual(start?.coordinates, {latitude: 40.721, longitude: -73.991});
    assert.equal(start?.approximate, true);
    assert.equal(start?.source?.title, 'Qloo area landmark');
    assert.equal(requests.qloo.length, 3);
    assert.deepEqual(requests.qloo.map(url => url.searchParams.get('types')), ['urn:entity:locality', 'urn:entity:locality', 'urn:entity:place']);
    assert.equal(requests.qloo[2]?.searchParams.get('query'), 'Market Quarter');
    assert.equal(requests.qloo[2]?.searchParams.get('take'), '10');
    assert.equal(requests.qloo[2]?.searchParams.get('filter.location'), `${venue.coordinates.latitude},${venue.coordinates.longitude}`);
  });
});

test('area anchor fallback rejects arbitrary businesses, fuzzy names, city conflicts, distance and distinct same-name locations', async () => {
  for (const anchors of [
    [areaAnchor(33, 'restaurant')],
    [areaAnchor(34, 'tourist_attraction', {commercial: true})],
    [{...areaAnchor(42, 'tourist_attraction'), tags: [{type: 'urn:tag:category:place', value: 'urn:tag:category:place:tourist_attraction'}, {type: 'urn:tag:category:place', value: 'urn:tag:category:place:bakery'}]}],
    [areaAnchor(35, 'subway_station', {name: 'Market Quarter East'})],
    [areaAnchor(36, 'subway_station', {city: 'Boston'})],
  ]) await withInterpretation('Market Quarter', 'neighborhood', areaOrAnchors(anchors), async config => {
    await assert.rejects(resolveStartingLocation(config, 'around Market Quarter', venue), errorCode('START_NOT_FOUND'));
  });
  await withInterpretation('Market Quarter', 'neighborhood', areaOrAnchors([areaAnchor(37, 'subway_station', {latitude: 40.9})]), async config => {
    await assert.rejects(resolveStartingLocation(config, 'around Market Quarter', venue), errorCode('START_OUT_OF_RANGE'));
  });
  await withInterpretation('Market Quarter', 'neighborhood', areaOrAnchors([areaAnchor(38, 'subway_station'), areaAnchor(39, 'subway_station', {latitude: 40.73})]), async config => {
    await assert.rejects(resolveStartingLocation(config, 'around Market Quarter', venue), errorCode('START_AMBIGUOUS'));
  });
});

test('an unavailable area-anchor lookup is retryable and locality ambiguity never falls through to an anchor', async () => {
  await withInterpretation('Market Quarter', 'neighborhood', url => url.searchParams.get('types') === 'urn:entity:place' ? new Response('{}', {status: 429}) : results([]), async (config, requests) => {
    await assert.rejects(resolveStartingLocation(config, 'around Market Quarter', venue), errorCode('START_UNAVAILABLE'));
    assert.equal(new Set(requests.qloo.map(url => url.href)).size, 3);
    assert.ok(requests.qloo.length <= 4);
  });
  await withInterpretation('Market Quarter', 'neighborhood', [area(40, 'Market Quarter'), area(41, 'Market Quarter', 40.73)], async (config, requests) => {
    await assert.rejects(resolveStartingLocation(config, 'around Market Quarter', venue), errorCode('START_AMBIGUOUS'));
    assert.equal(requests.qloo.length, 1);
    assert.equal(requests.qloo[0]?.searchParams.get('types'), 'urn:entity:locality');
  });
});

test('single-letter apartment identifiers cannot resolve to a different unit at the same building', async () => {
  await withInterpretation('126 Crosby Street Apt B, New York', 'address', [entity(43, 'Correct unit', '126 Crosby St Apt B, New York, NY')], async config => {
    assert.equal((await resolveStartingLocation(config, '126 Crosby Street Apt B', venue))?.address, '126 Crosby St Apt B, New York, NY');
  });
  await withInterpretation('126 Crosby Street Apt B, New York', 'address', [entity(44, 'Wrong unit', '126 Crosby St Apt C, New York, NY')], async config => {
    await assert.rejects(resolveStartingLocation(config, '126 Crosby Street Apt B', venue), needsDetails);
  });
});

test('apartment-first addresses cannot swap the apartment number and building number', async () => {
  await withInterpretation('Apartment 4, 126 Crosby Street, New York', 'address', [entity(45, 'Wrong building', '4 Crosby St Apartment 126, New York, NY')], async config => {
    await assert.rejects(resolveStartingLocation(config, 'Apartment 4, 126 Crosby Street', venue), needsDetails);
  });
});


test('private apartment details may be omitted when the provider verifies the correct public building entrance', async () => {
  for (const query of ['126 Crosby Street Apt B', '126 Crosby Street, Apt B', 'Apartment 4, 126 Crosby Street', '126 Crosby Street #4', 'Flat4, 126 Crosby Street']) {
    await withInterpretation(query, 'address', [entity(46, 'Public entrance', '126 Crosby St, New York, NY')], async (config, requests) => {
      const start = await resolveStartingLocation(config, query, venue);
      assert.equal(start?.address, '126 Crosby St, New York, NY');
      assert.equal(requests.qloo[0]?.searchParams.get('query'), '126 Crosby Street');
      assert.equal(start?.approximate, undefined);
    });
  }
  await withInterpretation('#126 Crosby Street', 'address', [entity(47, 'Public entrance', '126 Crosby St, New York, NY')], async config => {
    assert.equal((await resolveStartingLocation(config, '#126 Crosby Street', venue))?.address, '126 Crosby St, New York, NY');
  });
});

test('single-letter street names remain significant rather than matching a different named street', async () => {
  await withInterpretation('1 B Street', 'address', [entity(48, 'Wrong street', '1 C St, New York, NY')], async config => {
    await assert.rejects(resolveStartingLocation(config, '1 B Street', venue), needsDetails);
  });
});
