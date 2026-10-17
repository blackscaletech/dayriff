import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, PlanInput, Venue } from '../src/shared/types.js';
import {loadConfig} from '../src/server/config.js';
import {agentPlan} from '../src/server/providers/openai.js';
import {defaultTurnIntent as intent} from '../src/server/services/journey-intent.js';
import {findPlaces} from '../src/server/providers/qloo.js';
import {diningEvidence, FINE_DINING_TAGS, MICHELIN_COLLECTION, requestsMichelin, requiresVerifiedMichelin, resolveDiningFilter} from '../src/server/providers/dining-evidence.js';
import {checkPlan} from '../src/server/services/planner.js';
import {createRevisionMemory, rememberPlan} from '../src/server/services/revision-memory.js';

const venue: Venue = {id:'venue',name:'Concert',city:'New York',address:'New York, NY',coordinates:{latitude:40.7505045,longitude:-73.9934387},website:'',timezone:'America/New_York'};
const start = {name:'Starting neighborhood',address:'New York, NY',coordinates:{latitude:40.7234729441,longitude:-74.00086511},approximate:true};
const input: PlanInput = {artist:{id:'artist',name:'Artist'},venueId:venue.id,date:'2026-10-30',showTime:'17:30',durationMinutes:180,startingPoint:'around the neighborhood'};
const galleries: Place[] = [[40.7411,-73.9897],[40.7484,-73.9857]].map(([latitude,longitude],index)=>({id:`culture-${index}`,name:`Culture Stop ${index}`,category:'culture',address:'',coordinates:{latitude:latitude!,longitude:longitude!},description:'A cultural visitor attraction.',durationMinutes:35,taxonomy:['urn:tag:genre:place:museum']}));
const restaurantTag='urn:tag:genre:place:restaurant';
const veganTag='urn:tag:category:place:vegan_restaurant';
const diningId='66666666-6666-6666-6666-666666666661';
function entity(id:string,name:string,tags:string[],description='A fine-dining restaurant serving a seasonal menu.') {return {entity_id:id,name,subtype:'urn:entity:place',location:{lat:40.728,lon:-73.995},tags:tags.map(id=>({id,type:id.startsWith('urn:tag:resy:')?'urn:tag:resy:collection:place':id.startsWith('urn:tag:category:')?'urn:tag:category:place':'urn:tag:genre:place'})),properties:{description,price_level:3 as number | undefined}};}
const fine=entity(diningId,'Local Tasting Room',[restaurantTag,FINE_DINING_TAGS[0]!,MICHELIN_COLLECTION]);
const ordinary=entity('66666666-6666-6666-6666-666666666662','Costly Ordinary Restaurant',[restaurantTag],'A restaurant with high prices.');
const museum=entity('66666666-6666-6666-6666-666666666663','Museum Dining Amenity',[restaurantTag,FINE_DINING_TAGS[0]!,'urn:tag:genre:place:museum'],'A museum with dining amenities.');
const config=loadConfig({APP_MODE:'live',QLOO_API_URL:'https://api.qloo.com',QLOO_API_KEY:'premium-test-only',OPENAI_API_KEY:'test-only'});
function json(value:unknown){return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});}
function tool(name:string,args:unknown){return json({output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:'test-call'}]});}
function proposal(ids:string[],extra:Record<string,unknown>={}){return {action:'adjust',minimum_changes:1,drop_preferences:[],reject_ids:[],restore_ids:[],stop_ids:ids,budget_update:'unchanged',arrival_update:'unchanged',walking:'unchanged',clarification:null,clarification_kind:null,stop_notes:[],...extra};}
async function prior(){const checked=await checkPlan({ids:galleries.map(p=>p.id),input,venue,candidates:galleries,mode:'live',startingLocation:start});assert.ok(checked.itinerary);return checked.itinerary;}
function lookup(url:URL,places=[fine,ordinary,museum]) {return url.pathname==='/v2/tags'?json({results:{tags:[{tag_id:restaurantTag,type:'urn:tag:genre:place',name:'Restaurant'}]}}):json({results:{entities:places}});}

test('More culture can rebalance into qualified dining without invented counts, budget or Michelin stars',async()=>{
 const previous=await prior();
 const memory=rememberPlan(createRevisionMemory(previous),previous,[{query:'culture',category:'culture',ids:galleries.map(p=>p.id),minimum:2,strength:'preference'}]);
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(resource,init)=>{const url=new URL(String(resource));if(url.hostname!=='api.openai.com')return lookup(url);calls++;if(calls===1){const sent=JSON.parse(String(init?.body));assert.equal(sent.tool_choice.name,'find_places');return tool('find_places',{query:'Michelin-starred restaurant',minimum_stops:2,refine_previous_search:false,purpose:'preference',requirement:'preference',dining_style:'fine_dining',recognition:'michelin',drop_preferences:[]});}return tool('check_plan',proposal(galleries.map(p=>p.id)));};
 try{
  const result=await agentPlan({config,input,venue,candidates:galleries,previous,startingLocation:start,memory,excludedIds:[],messages:[{role:'user',text:'More culture'}],turnIntent:intent({kind:'adjust',placeRequests:[{query:'restaurant',minimum:1,strength:'preference',diningStyle:'high_end',recognition:'michelin'}]}),request:{message:'more high end restaurants, michelin star'}});
  assert.ok(result.itinerary,result.clarification);
  assert.equal(result.itinerary.stops.length,1,'A 90-minute dining allowance plus travel cannot fit the old two-stop culture minimum');
  assert.equal(result.itinerary.stops[0]!.id,diningId);
  assert.equal(result.itinerary.stops[0]!.durationMinutes,90);
  assert.ok(result.itinerary.totalMinutes<=180);
  assert.deepEqual(result.itinerary.input,input,'High-end taste cannot rewrite absent budget/arrival constraints');
  assert.equal(result.memory.walkingLimit,undefined,'More culture never creates a walking preference');
  assert.equal(result.memory.preferences.find(p=>p.query==='culture')?.minimum,2,'The earlier taste is remembered rather than erased');
  assert.equal(result.memory.preferences.find(p=>p.diningStyle==='high_end')?.minimum,1,'Unnumbered more must not invent a mandatory second meal');
  assert.match(result.message!,/couldn't verify current Michelin-star status/);
  assert.match(result.message!,/90-minute planning allowance/);
  assert.equal(calls,1,'A checked typed refinement applies directly after discovery');
 }finally{globalThis.fetch=original;}
});

test('explicit keep-both culture remains hard during a later dining request',async()=>{
 const previous=await prior();const memory=rememberPlan(createRevisionMemory(previous),previous,[{query:'culture',category:'culture',ids:galleries.map(p=>p.id),minimum:2,strength:'preference'}]);
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(resource)=>{const url=new URL(String(resource));if(url.hostname!=='api.openai.com')return lookup(url);calls++;return calls===1?tool('find_places',{query:'restaurant',minimum_stops:1,refine_previous_search:false,purpose:'preference',dining_style:'fine_dining',recognition:'any',requirement:'preference',drop_preferences:[]}):tool('check_plan',proposal([diningId],{drop_preferences:['culture']}));};
 try{
  const result=await agentPlan({config,input,venue,candidates:galleries,previous,startingLocation:start,memory,excludedIds:[],messages:[],turnIntent:intent({kind:'adjust',keepPreferences:['culture'],placeRequests:[{query:'restaurant',minimum:1,strength:'required',diningStyle:'fine_dining'}]}),request:{message:'Keep both cultural stops and add a fine dining restaurant'}});
  assert.equal(result.itinerary,undefined,'A model drop request cannot relax the user\'s explicit preservation instruction');
  assert.match(result.clarification!,/keeping 2 culture stops/);
  assert.match(result.clarification!,/180-minute/);
  assert.deepEqual(result.memory,memory,'A failed update leaves the accepted plan state intact');
 }finally{globalThis.fetch=original;}
});

test('Michelin-only requests retain the route when current stars cannot be verified',async()=>{
 const previous=await prior();const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(resource)=>{const url=new URL(String(resource));if(url.hostname!=='api.openai.com')return lookup(url);calls++;return tool('find_places',{query:'restaurant',minimum_stops:1,refine_previous_search:false,purpose:'preference',requirement:'required',dining_style:'fine_dining',recognition:'michelin',drop_preferences:[]});};
 try{
  const result=await agentPlan({config,input,venue,candidates:galleries,previous,startingLocation:start,excludedIds:[],messages:[],turnIntent:intent({kind:'adjust',placeRequests:[{query:'restaurant',minimum:1,strength:'required',diningStyle:'fine_dining',recognition:'michelin'}]}),request:{message:'Only currently Michelin-starred restaurants'}});
  assert.equal(result.itinerary,undefined);
  assert.match(result.clarification!,/cannot verify current Michelin-star status/);
  assert.match(result.clarification!,/plan is unchanged/);
  assert.equal(calls,0,'Do not search for star evidence the configured providers cannot verify');
 }finally{globalThis.fetch=original;}
});

test('premium dining keeps cuisine constraints and treats Michelin association and negation accurately',async()=>{
 const vegan=entity('66666666-6666-6666-6666-666666666664','Vegan Tasting Room',[restaurantTag,FINE_DINING_TAGS[0]!,veganTag,MICHELIN_COLLECTION]);
 const original=globalThis.fetch;
 globalThis.fetch=async resource=>{const url=new URL(String(resource));return url.pathname==='/v2/tags'?json({results:{tags:[{tag_id:veganTag,type:'urn:tag:category:place',name:'Vegan restaurant'}]}}):lookup(url,[fine,ordinary,museum,vegan]);};
 try{
  const found=await findPlaces({...config,qlooApiKey:'vegan-premium-test'},input.artist,venue,'vegan restaurants',start,{diningStyle:'fine_dining',recognition:'michelin'});
  assert.deepEqual(found.places.map(p=>p.name),['Vegan Tasting Room']);
  assert.equal(found.query,'vegan restaurants');
  assert.equal(found.places[0]!.diningEvidence?.michelinCollection,true);
  assert.equal('michelinStars' in found.places[0]!,false,'Collection membership never becomes a current-star claim');
  const negated="I don't require Michelin stars; just regular restaurants";
  assert.equal(requestsMichelin(negated),false);assert.equal(requiresVerifiedMichelin(negated),false);
  assert.deepEqual(resolveDiningFilter(negated,{dining_style:'fine_dining',recognition:'michelin'}),{diningStyle:undefined,recognition:undefined});
  assert.equal(diningEvidence({tags:['urn:tag:nearby_attraction:qloo:michelin_star_restaurants','urn:tag:customer_identity:qloo:michelin_star_seekers']}),undefined);
 }finally{globalThis.fetch=original;}
});


test('final dining metadata revealing closed hours selects another grounded option within the same window',async()=>{
 const previous=await prior();
 const openId='66666666-6666-6666-6666-666666666665';
 const lunch=entity(openId,'Lunch Tasting Room',[restaurantTag,FINE_DINING_TAGS[0]!]);
 const original=globalThis.fetch;let calls=0,detailCalls=0;
 globalThis.fetch=async resource=>{
  const url=new URL(String(resource));
  if(url.hostname==='api.openai.com'){
   calls++;
   return calls===1?tool('find_places',{query:'restaurant',minimum_stops:1,refine_previous_search:false,purpose:'preference',requirement:'preference',dining_style:'fine_dining',recognition:'any',drop_preferences:[]}):tool('check_plan',proposal([diningId]));
  }
  if(url.pathname==='/entities'){
   detailCalls++;
   const chosen=url.searchParams.get('entity_ids')?.includes(diningId)?fine:lunch;
   return json({results:{entities:[{...chosen,properties:{...chosen.properties,hours:{friday:[{closed:false,opens:chosen===fine?'17:00':'12:00',closes:'22:00'}]}}}]}});
  }
  return lookup(url,[fine,lunch]);
 };
 try{
  const result=await agentPlan({config:{...config,qlooApiKey:'hours-premium-test'},input,venue,candidates:galleries,previous,startingLocation:start,excludedIds:[],messages:[],turnIntent:intent({kind:'adjust',placeRequests:[{query:'restaurant',minimum:1,strength:'preference',diningStyle:'fine_dining'}]}),request:{message:'More fine dining restaurants'}});
  assert.ok(result.itinerary,result.clarification);
  assert.deepEqual(result.itinerary.stops.map(p=>p.id),[openId],'A provider-known closed dinner room must not survive final validation');
  assert.ok(result.itinerary.totalMinutes<=180);
  assert.equal(result.itinerary.stops[0]!.openingHours?.[0]?.periods[0]?.opens,'12:00');
  assert.ok(detailCalls<=3,'Metadata repair is bounded');
  assert.equal(calls,1,'A metadata repair needs no additional selection model call');
 }finally{globalThis.fetch=original;}
});


test('high-end refinement rejects contradictory low-tier tags, prefers verified premium tiers and discloses missing hours',async()=>{
 const previous=await prior();
 const cheap={...fine,entity_id:'66666666-6666-6666-6666-666666666666',name:'Historic Comfort Tavern',properties:{description:'A historic tavern serving comfort food.',price_level:1}};
 const unknown={...fine,entity_id:'66666666-6666-6666-6666-666666666667',name:'Unknown Price Dining Room',properties:{description:'A fine dining room.',price_level:undefined}};
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async resource=>{
  const url=new URL(String(resource));
  if(url.hostname!=='api.openai.com')return lookup(url,[cheap,unknown,fine]);
  calls++;return calls===1?tool('find_places',{query:'high-end restaurants',minimum_stops:1,refine_previous_search:false,purpose:'preference',requirement:'preference',dining_style:'fine_dining',recognition:'michelin',drop_preferences:[]}):tool('check_plan',proposal([cheap.entity_id]));
 };
 try{
  const result=await agentPlan({config:{...config,qlooApiKey:'tier-premium-test'},input:{...input,date:'2026-10-21'},venue,candidates:galleries,previous,startingLocation:start,excludedIds:[],messages:[],turnIntent:intent({kind:'adjust',placeRequests:[{query:'restaurant',minimum:1,strength:'preference',diningStyle:'high_end',recognition:'michelin'}]}),request:{message:'more high end restaurants, michelin star'}});
  assert.ok(result.itinerary,result.clarification);
  assert.deepEqual(result.itinerary.stops.map(p=>p.id),[diningId]);
  assert.equal(result.itinerary.stops[0]!.costTier,3,'Known premium tiers are preferred over unknown prices');
  assert.equal(result.itinerary.input.budget,undefined,'High-end is a taste rather than an inferred budget');
  assert.ok(!result.memory.preferences.find(p=>p.diningStyle==='high_end')?.ids.includes(cheap.entity_id));
  assert.match(result.message!,/couldn't verify current Michelin-star status/);
  assert.match(result.message!,/no listed hours for Wednesday/);
  assert.deepEqual(resolveDiningFilter('high end restaurants',{dining_style:'fine_dining',recognition:'any'}),{diningStyle:'high_end',recognition:undefined});
 }finally{globalThis.fetch=original;}
});
