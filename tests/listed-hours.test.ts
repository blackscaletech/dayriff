import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, PlanInput, Venue } from '../src/shared/types.js';
import { listedVisitFits } from '../src/server/services/listed-hours.js';
import { checkPlan, suggestStopIds } from '../src/server/services/planner.js';

const place: Place = {id:'dinner', name:'Dinner Room', category:'food', address:'', coordinates:{latitude:40.75,longitude:-73.99}, description:'A local restaurant.', durationMinutes:90,
  openingHours:[{day:'wednesday',closed:false,periods:[{opens:'17:00',closes:'22:00'}]}]};
const date = '2026-10-21';
test('listed weekly hours exclude closed visits without treating unknown days as closed',()=>{
  assert.equal(listedVisitFits(place,date,14*60+49),false);
  assert.equal(listedVisitFits(place,date,17*60),true);
  assert.equal(listedVisitFits(place,date,21*60),false,'The estimated visit must fit before closing');
  assert.equal(listedVisitFits(place,'2026-10-22',14*60),true,'Missing days remain unknown');
  assert.equal(listedVisitFits({...place,openingHours:undefined},date,14*60),true);
  assert.equal(listedVisitFits({...place,openingHours:[{day:'wednesday',closed:false,periods:[{opens:'12:00',closes:'17:00'},{opens:'17:00',closes:'22:00'}]}]},date,16*60+30),true,'Adjacent service windows cover a continuous visit');
  assert.equal(listedVisitFits({...place,openingHours:[{day:'wednesday',closed:false,periods:[]}]},date,14*60),true,'An empty non-closed schedule remains unknown');
  const late={...place,durationMinutes:30,openingHours:[{day:'wednesday',closed:false,periods:[{opens:'22:00',closes:'02:00'}]},{day:'thursday',closed:true,periods:[]}]};
  assert.equal(listedVisitFits(late,date,24*60+30),true,'Overnight Wednesday hours cover early Thursday');
  assert.equal(listedVisitFits(late,date,26*60),false);
});
test('ranking and final route validation reject known closed dining and preserve an available alternative',async()=>{
  const venue: Venue={id:'venue',name:'Concert',city:'New York',address:'',coordinates:place.coordinates,website:'',timezone:'America/New_York'};
  const input: PlanInput={artist:{id:'artist',name:'Artist'},venueId:venue.id,date,showTime:'17:30',durationMinutes:180,startingPoint:'venue'};
  const open={...place,id:'lunch',name:'Lunch Room',openingHours:[{day:'wednesday',closed:false,periods:[{opens:'12:00',closes:'17:00'}]}]};
  assert.deepEqual(suggestStopIds(input,venue,[place,open]),[open.id]);
  const closed=await checkPlan({ids:[place.id],input,venue,candidates:[place,open],mode:'live'});
  assert.equal(closed.valid,false);assert.match(closed.issues.join(' '),/Dinner Room.*listed hours/);
  assert.ok((await checkPlan({ids:[open.id],input,venue,candidates:[place,open],mode:'live'})).itinerary);
});
