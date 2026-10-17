import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {registerRoutes, type SessionState} from '../src/server/routes.js';
import {registerErrorHandler} from '../src/server/app.js';
import {loadConfig} from '../src/server/config.js';

test('city browsing retains confirmed artist and venue identities through plan submission', async () => {
  const app = Fastify();
  registerErrorHandler(app);
  const session: SessionState = {artists: [], venues: [], cities: [], messages: [], excludedIds: [], history: []};
  await registerRoutes(app, {config: loadConfig({APP_MODE: 'sample'}), getSession: () => session});
  try {
    const artists = (await app.inject('/api/artists?q=Khruangbin')).json().artists;
    const cities = (await app.inject('/api/venues?q=new%20york')).json().cities;
    assert.equal(cities[0].name, 'New York');
    const scoped = await app.inject(`/api/venues?cityId=${encodeURIComponent(cities[0].id)}&q=`);
    assert.equal(scoped.statusCode, 200);
    const {venues} = scoped.json();
    assert.ok(venues.length);
    const input = {artist: artists[0], venueId: venues[0].id, date: '2026-10-15', showTime: '17:30', durationMinutes: 180, startingPoint: 'Near the venue'};
    const plan = await app.inject({method: 'POST', url: '/api/plans', payload: input});
    assert.equal(plan.statusCode, 200, plan.body);
    assert.equal(plan.json().itinerary.venue.id, venues[0].id);
    assert.equal(plan.json().itinerary.input.artist.id, artists[0].id);
    const cityAsVenue = await app.inject({method: 'POST', url: '/api/plans', payload: {...input, venueId: cities[0].id}});
    assert.equal(cityAsVenue.statusCode, 400, 'A city must never become a pretend concert venue');
    assert.equal((await app.inject('/api/venues?cityId=unverified-city')).statusCode, 400);
  } finally { await app.close(); }
});
