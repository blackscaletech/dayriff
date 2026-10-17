import assert from 'node:assert/strict';
import test from 'node:test';
import type { Place, PlanInput, Venue } from '../src/shared/types.js';
import type {ServerConfig} from '../src/server/config.js';
import { agentPlan } from '../src/server/providers/openai.js';
import { matchesPlacePreference } from '../src/server/providers/qloo.js';
import { defaultTurnIntent, type TurnIntent } from '../src/server/services/journey-intent.js';
import { checkPlan } from '../src/server/services/planner.js';
import { createRevisionMemory, rememberPlan } from '../src/server/services/revision-memory.js';
import {derivePlanningWindow} from '../src/shared/planning-window.js';
import { capturePlan } from '../src/server/services/plan-history.js';

const venue: Venue = {id:'venue',name:'Concert',city:'New York',address:'New York, NY',coordinates:{latitude:40.72,longitude:-73.99},website:'',timezone:'America/New_York'};
const input: PlanInput = {artist:{id:'artist',name:'Artist'},venueId:venue.id,date:'2026-10-21',showTime:'16:50',durationMinutes:140,startingPoint:'venue'};
const ordinary: Place[] = [0,1,2].map(index=>({id:`local-${index}`,name:`Local Bookshop ${index}`,category:'shop',address:'',coordinates:{latitude:40.7201+index*.0001,longitude:-73.99},description:'A neighborhood bookstore with local literature.',taxonomy:['urn:tag:genre:place:bookstore'],costTier:1,durationMinutes:25}));
const fine: Place = {id:'fine',name:'Tasting Room',category:'food',address:'',coordinates:{latitude:40.73,longitude:-73.99},description:'A fine-dining restaurant.',taxonomy:['urn:tag:genre:place:restaurant'],costTier:3,diningEvidence:{fineDining:true,michelinCollection:true},durationMinutes:90};
const config: ServerConfig = {mode: 'live', production: false, port: 3000, host: '127.0.0.1', qlooApiUrl: 'https://api.qloo.com', qlooApiKey: 'turn-boundary-test', openaiApiKey: 'test-only', openaiModel: 'offline-test', openaiReasoningEffort: 'medium', cookieSecret: 'offline-cookie-secret', maxDailyPlans: 100, maxDailyLookups: 2000};
function json(value:unknown){return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});}
function tool(name:string,args:unknown){return json({output:[{type:'function_call',name,arguments:JSON.stringify(args),call_id:'test-call'}]});}
function wire(overrides:Partial<TurnIntent>){const value=defaultTurnIntent(overrides);return {kind:value.kind,stop_count_operation:value.stopCount===null?'clear':value.stopCount?'set':'unchanged',minimum_total_stops:value.stopCount?.minimum??0,maximum_total_stops:value.stopCount?.maximum??0,
 replace_stop_id:value.replaceStopId??null,keep_stop_ids:value.keepStopIds,place_scope:value.placeScope,place_policy_facts:[],place_requests:value.placeRequests.map(({category,diningStyle,recognition,exclusive,maximum,operation,scope,...place})=>({...place,maximum:maximum??null,operation:operation??'at_least',scope:scope??'plan',category:category??'any',dining_style:diningStyle??'any',recognition:recognition??'any',exclusive:exclusive??false})),drop_preferences:value.dropPreferences,keep_preferences:value.keepPreferences,minimum_changes:value.minimumChanges,budget_update:value.budgetUpdate,arrival_update:value.arrivalUpdate,show_time_update:value.showTimeUpdate,duration_update:value.durationUpdate==='unchanged'?null:value.durationUpdate,walking:value.walking,reject_ids:value.rejectIds,restore_ids:value.restoreIds,clarification:value.clarification??null};}
async function prior(candidates:Place[],ids=candidates.slice(0,1).map(place=>place.id),planInput=input){const checked=await checkPlan({ids,input:planInput,venue,candidates,mode:'live'});assert.ok(checked.itinerary,checked.issues.join(' '));return checked.itinerary;}

test('semantic multi-turn dining → whichever three → mixed-question pair preserves count goals and real meal time',async()=>{
 const candidates=[fine,...ordinary];let previous=await prior(candidates,ordinary.slice(0,2).map(place=>place.id));let memory=createRevisionMemory(previous);
 const original=globalThis.fetch;let interpretations=0,answers=0;
 const intents=[wire({kind:'adjust',placeRequests:[{query:'restaurant',minimum:1,strength:'preference',diningStyle:'fine_dining',recognition:'michelin'}]}),wire({kind:'adjust',placeScope:'any',stopCount:{minimum:3,maximum:3}}),wire({kind:'adjust',placeRequests:[{query:'bookstore',category:'shop',minimum:1,strength:'preference'}]}),wire({kind:'adjust',stopCount:{minimum:2,maximum:2}}),wire({kind:'answer'})];
 globalThis.fetch=async(resource,init)=>{assert.equal(new URL(String(resource)).hostname,'api.openai.com','Cached goals never require discovery');const body=JSON.parse(String(init?.body));
  if(body.tools[0].name==='interpret_turn'){const context=JSON.parse(body.input[0].content);assert.equal(context.currentPlan.input.durationMinutes,140);return tool('interpret_turn',intents[interpretations++]);}
  assert.equal(body.tools[0].name,'answer_plan');answers++;return tool('answer_plan',{answer:'The current outing has two bookstores, selected from the supplied local place facts.'});};
 try{
  const first=await agentPlan({config,input,venue,candidates,previous,memory,request:{message:'let’s do michelin star restaurants instead'},messages:[],excludedIds:[]});
  assert.ok(first.itinerary,first.clarification);assert.equal(first.itinerary.stops.length,1);assert.equal(first.itinerary.stops[0]!.id,fine.id);assert.equal(first.itinerary.stops[0]!.durationMinutes,90);
  previous=first.itinerary;memory=first.memory;
  const second=await agentPlan({config,input,venue,candidates:first.candidates,previous,memory,request:{message:'let’s make a plan with whichever recommendations but so we have at least 3 options'},messages:[],excludedIds:[]});
  assert.ok(second.itinerary,second.clarification);assert.equal(second.itinerary.stops.length,3);assert.ok(second.itinerary.stops.every(place=>place.id!==fine.id));
  assert.equal(second.candidates.find(place=>place.id===fine.id)!.durationMinutes,90,'Relaxation replaces the meal rather than shrinking its real allowance');
  assert.deepEqual(second.itinerary.input,input);assert.deepEqual(second.memory.stopCount,{minimum:3,maximum:3});assert.equal(second.memory.preferences.length,0);assert.match(second.message!,/plan has 3 stops/);
  const snapshot=capturePlan(second.itinerary,second.memory,[]);assert.deepEqual(snapshot.stopCount,second.memory.stopCount);
  const satisfied=await agentPlan({config,input,venue,candidates:second.candidates,previous:second.itinerary,memory:second.memory,request:{message:'Could one of those be a bookstore?'},messages:[],excludedIds:[]});
  assert.ok(satisfied.itinerary);assert.equal(satisfied.itinerary.revision,second.itinerary.revision);assert.match(satisfied.message!,/already includes Local Bookshop/);assert.equal(satisfied.itinerary.stops.length,3);
  const third=await agentPlan({config,input,venue,candidates:second.candidates,previous:second.itinerary,memory:second.memory,request:{message:'Why are there so many—could we make it a pair of places?'},messages:[],excludedIds:[]});
  assert.ok(third.itinerary,third.clarification);assert.equal(third.itinerary.stops.length,2);assert.deepEqual(third.memory.stopCount,{minimum:2,maximum:2});
  const state=structuredClone(third.memory);
  const question=await agentPlan({config,input,venue,candidates:third.candidates,previous:third.itinerary,memory:third.memory,request:{message:'What makes these places a match?'},messages:[],excludedIds:[]});
  assert.equal(question.itinerary,undefined);assert.deepEqual(question.memory,state);assert.equal(question.candidates,third.candidates);assert.equal(interpretations,5);assert.equal(answers,1);
 }finally{globalThis.fetch=original;}
});

test('broader total-count discovery cannot acquire phantom tastes or edit hard inputs through execution fields',async()=>{
 const planInput={...input,budget:'low' as const,arrivalBy:'16:30'};
 const blocked={...ordinary[2]!,id:'blocked'};const candidates=[...ordinary.slice(0,2),blocked];const previous=await prior(candidates,ordinary.slice(0,2).map(place=>place.id),planInput);
 const memory=rememberPlan(createRevisionMemory(previous),previous,[{query:'bookstore',category:'shop',ids:ordinary.slice(0,2).map(place=>place.id),minimum:1,strength:'required'}]);
 const bookTag='urn:tag:genre:place:bookstore';const newId='77777777-7777-7777-7777-777777777771';let interpreterCalls=0,executionCalls=0;
 const original=globalThis.fetch;
 globalThis.fetch=async(resource,init)=>{const url=new URL(String(resource));if(url.hostname==='api.openai.com'){const body=JSON.parse(String(init?.body));
  if(body.tools[0].name==='interpret_turn'){interpreterCalls++;return tool('interpret_turn',wire({kind:'adjust',placeScope:'any',stopCount:{minimum:3,maximum:3},placeRequests:[{query:'bookstore',category:'shop',minimum:1,strength:'required'}]}));}
  executionCalls++;assert.equal(body.tool_choice.name,'find_places');assert.deepEqual(Object.keys(body.tools[0].parameters.properties),['query','preference_query']);
  return tool('find_places',{query:'bookstore',preference_query:null,purpose:'preference',minimum_stops:1,dining_style:'fine_dining',recognition:'michelin',budget_update:'unset',arrival_update:'unset',walking:'clear_limit',restore_ids:['blocked'],drop_preferences:['bookstore']});}
  if(url.pathname==='/v2/tags')return json({results:{tags:[{tag_id:bookTag,type:'urn:tag:genre:place',name:'Bookstore'}]}});
  return json({results:{entities:[{entity_id:newId,name:'New Local Bookstore',subtype:'urn:entity:place',location:{lat:40.7204,lon:-73.99},tags:[{id:bookTag,type:'urn:tag:genre:place'}],properties:{description:'A neighborhood bookstore with regional literature.',price_level:1}}]}});
 };
 try{
  const result=await agentPlan({config:{...config,qlooApiKey:'count-discovery-test'},input:planInput,venue,candidates,previous,memory,request:{message:'A trio of whichever nearby recommendations works'},messages:[],excludedIds:['blocked']});
  assert.ok(result.itinerary,result.clarification);assert.equal(result.itinerary.stops.length,3);assert.ok(result.itinerary.stops.some(place=>place.id===newId));assert.ok(!result.itinerary.stops.some(place=>place.id==='blocked'));
  assert.deepEqual(result.itinerary.input,planInput);assert.deepEqual(result.excludedIds,['blocked']);assert.equal(result.memory.preferences.length,1);assert.equal(result.memory.preferences[0]!.query,'bookstore');assert.equal(result.memory.preferences[0]!.strength,'required');
  assert.deepEqual(result.memory.stopCount,{minimum:3,maximum:3});assert.equal(interpreterCalls,1);assert.equal(executionCalls,1,'One semantic call and one discovery execution suffice');
 }finally{globalThis.fetch=original;}
});

test('an infeasible explicit count is never reported as unchanged success after bounded discovery',async()=>{
 const planInput={...input,durationMinutes:70};const candidates=ordinary.slice(0,2);const previous=await prior(candidates,undefined,planInput);const memory=createRevisionMemory(previous);const original=globalThis.fetch;let executionCalls=0;
 globalThis.fetch=async(resource,init)=>{const url=new URL(String(resource));if(url.hostname==='api.openai.com'){const body=JSON.parse(String(init?.body));if(body.tools[0].name==='interpret_turn')return tool('interpret_turn',wire({kind:'adjust',placeScope:'any',stopCount:{minimum:3,maximum:3}}));executionCalls++;
  return executionCalls<=2?tool('find_places',{query:'bookstore',preference_query:null}):tool('check_plan',{stop_ids:[ordinary[0]!.id],stop_notes:[],clarification:null});}
  if(url.pathname==='/v2/tags')return json({results:{tags:[{tag_id:'urn:tag:genre:place:bookstore',type:'urn:tag:genre:place',name:'Bookstore'}]}});
  return json({results:{entities:[{entity_id:'77777777-7777-7777-7777-777777777772',name:'Another Bookstore',subtype:'urn:entity:place',location:{lat:40.7202,lon:-73.99},tags:[{id:'urn:tag:genre:place:bookstore',type:'urn:tag:genre:place'}],properties:{description:'A neighborhood bookstore.',price_level:1}}]}});
 };
 try{
  const result=await agentPlan({config:{...config,qlooApiKey:'infeasible-count-test'},input:planInput,venue,candidates,previous,memory,request:{message:'Make it three, any kinds of places'},messages:[],excludedIds:[]});
  assert.equal(result.itinerary,undefined);assert.deepEqual(result.memory,memory);assert.match(result.clarification!,/could not fit 3 stops/);assert.match(result.clarification!,/70-minute/);assert.match(result.clarification!,/verified options fit 2 stops/);assert.doesNotMatch(result.clarification!,/No places changed/);assert.ok(executionCalls<=3,'Discovery failure stays bounded and does not require redundant model repairs');
 }finally{globalThis.fetch=original;}
});

test('specific subtypes and exclusive tastes remain hard even when broad categories are supplied',async()=>{
 const gift={...ordinary[0]!,id:'gifts',name:'Local Gifts',description:'A local craft and gift shop.',taxonomy:['urn:tag:genre:place:gift_shop']};
 assert.equal(matchesPlacePreference(gift,{query:'bookstore',category:'shop'}),false);assert.equal(matchesPlacePreference(ordinary[0]!,{query:'bookstore',category:'shop'}),true);
 const candidates=[ordinary[0]!,ordinary[1]!,gift];const previous=await prior(candidates,[gift.id]);
 const result=await agentPlan({config,input,venue,candidates,previous,request:{message:'Only bookstores'},turnIntent:defaultTurnIntent({kind:'adjust',placeRequests:[{query:'bookstore',category:'shop',minimum:1,strength:'required',exclusive:true}]}),messages:[],excludedIds:[]});
 assert.ok(result.itinerary,result.clarification);assert.equal(result.itinerary.stops.length,2);assert.ok(result.itinerary.stops.every(place=>place.id!==gift.id));assert.equal(result.memory.preferences[0]!.exclusive,true);
});


test('a broader count goal discovers short visits from capacity policy without another planner interpretation',async()=>{
 const candidates=ordinary.slice(0,2);const previous=await prior(candidates);const original=globalThis.fetch;let modelCalls=0;const searched:string[]=[];
 globalThis.fetch=async(resource,init)=>{const url=new URL(String(resource));if(url.hostname==='api.openai.com'){modelCalls++;const body=JSON.parse(String(init?.body));assert.equal(body.tools[0].name,'interpret_turn','Capacity repair needs no planner-model round');return tool('interpret_turn',wire({kind:'adjust',placeScope:'any',stopCount:{minimum:3,maximum:3}}));}
  if(url.pathname==='/v2/tags'){searched.push(url.searchParams.get('filter.query')!);return json({results:{tags:[{tag_id:'urn:tag:genre:place:bookstore',type:'urn:tag:genre:place',name:'Bookstore'}]}});}
  return json({results:{entities:[{entity_id:'77777777-7777-7777-7777-777777777773',name:'Short Local Bookstore',subtype:'urn:entity:place',location:{lat:40.7203,lon:-73.99},tags:[{id:'urn:tag:genre:place:bookstore',type:'urn:tag:genre:place'}],properties:{description:'A neighborhood bookstore.',price_level:1}}]}});
 };
 try{
  const result=await agentPlan({config:{...config,qlooApiKey:'capacity-count-test'},input,venue,candidates,previous,messages:[],excludedIds:[],request:{message:'Whichever recommendations fit, at least three options'}});
  assert.ok(result.itinerary,result.clarification);assert.equal(result.itinerary.stops.length,3);assert.deepEqual(searched,['bookstore']);assert.equal(modelCalls,1);assert.ok(result.itinerary.totalMinutes<=input.durationMinutes);assert.equal(result.memory.preferences.length,0,'Capacity discovery does not invent a bookstore preference');
 }finally{globalThis.fetch=original;}
});


test('semantic show, duration and arrival edits rederive the schedule while preserving omitted preferences and rejected turns', async () => {
  let previous = await prior(ordinary, ordinary.slice(0, 2).map(place => place.id));
  let memory = createRevisionMemory(previous);
  const original = globalThis.fetch;
  const turns: {message: string; intent: Partial<TurnIntent>; start: string; arrival: string}[] = [
    {message: 'Actually the show starts at 7 pm', intent: {showTimeUpdate: '19:00'}, start: '16:10', arrival: '18:30'},
    {message: 'Let’s spend three hours exploring', intent: {durationUpdate: 180}, start: '15:30', arrival: '18:30'},
    {message: 'Get me there at 6:45 pm', intent: {arrivalUpdate: '18:45'}, start: '15:45', arrival: '18:45'},
    {message: 'Remove my arrival preference', intent: {arrivalUpdate: 'unset'}, start: '15:30', arrival: '18:30'},
  ];
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com', 'Schedule edits use the checked place pool');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].name, 'interpret_turn', 'Schedule edits need one semantic interpretation and no selection-model repair');
    const update = turns[calls++]!;
    return tool('interpret_turn', wire(update.intent));
  };
  try {
    for (const turn of turns) {
      const result = await agentPlan({config, input: previous.input, venue, candidates: ordinary, previous, memory,
        request: {message: turn.message}, messages: [], excludedIds: []});
      assert.ok(result.itinerary, result.clarification);
      const window = derivePlanningWindow(result.itinerary.input);
      assert.equal(window.startTime, turn.start);
      assert.equal(window.arrivalTime, turn.arrival);
      assert.equal(result.itinerary.input.budget, undefined);
      assert.deepEqual(result.itinerary.stops.map(place => place.id), previous.stops.map(place => place.id));
      previous = result.itinerary;
      memory = result.memory;
    }
    assert.equal(calls, turns.length);
    assert.equal(previous.input.arrivalBy, undefined);
    const explicit = await agentPlan({config, input: previous.input, venue, candidates: ordinary, previous, memory,
      turnIntent: defaultTurnIntent({arrivalUpdate: '18:45'}), request: {message: 'Arrive at 6:45 pm'}, messages: [], excludedIds: []});
    assert.ok(explicit.itinerary, explicit.clarification);
    const before = structuredClone(explicit.itinerary), beforeMemory = structuredClone(explicit.memory);
    const incompatible = await agentPlan({config, input: explicit.itinerary.input, venue, candidates: ordinary, previous: explicit.itinerary, memory: explicit.memory,
      turnIntent: defaultTurnIntent({showTimeUpdate: '18:00'}), request: {message: 'The show starts at 6 pm'}, messages: [], excludedIds: []});
    assert.equal(incompatible.itinerary, undefined);
    assert.match(incompatible.clarification!, /arrival.*before.*show/i);
    assert.deepEqual(incompatible.memory, beforeMemory);
    assert.deepEqual(explicit.itinerary, before);
    assert.equal(calls, turns.length, 'Invalid combined inputs clarify without a model retry');
  } finally {globalThis.fetch = original;}
});


test('a single semantic chat interpretation can replace the first stop atomically', async () => {
  const candidates = [...ordinary, {...ordinary[0]!, id: 'new-books', affinity: .1}, {...ordinary[1]!, id: 'higher-score-books', affinity: 1}];
  const previous = await prior(candidates, ordinary.map(stop => stop.id));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].name, 'interpret_turn', 'A cached targeted replacement needs only the semantic model call');
    const parameters = body.tools[0].parameters;
    assert.deepEqual(parameters.properties.replace_stop_id.type, ['string', 'null']);
    assert.ok(parameters.required.includes('replace_stop_id'));
    const context = JSON.parse(body.input[0].content);
    assert.equal(context.currentPlan.stops[0].id, previous.stops[0]!.id);
    return tool('interpret_turn', wire({kind: 'adjust', replaceStopId: previous.stops[0]!.id, keepStopIds: previous.stops.slice(1).map(stop => stop.id)}));
  };
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, request: {message: 'Swap the first stop but keep the others'}, messages: [], excludedIds: []});
    assert.ok(result.itinerary, result.clarification);
    assert.notEqual(result.itinerary.stops[0]!.id, previous.stops[0]!.id);
    assert.deepEqual(result.itinerary.stops.slice(1).map(stop => stop.id), previous.stops.slice(1).map(stop => stop.id));
    assert.equal(result.itinerary.stops.length, previous.stops.length);
    assert.deepEqual(result.itinerary.input, input);
    assert.equal(calls, 1);
  } finally {globalThis.fetch = original;}
});


test('the semantic tool separates a replacement kind from a numeric whole-plan keep requirement', async () => {
  const cultures: Place[] = ordinary.map((stop, index) => ({...stop, id: `culture-${index}`, category: 'culture', description: 'A neighborhood art gallery.', taxonomy: ['urn:tag:genre:place:art_gallery']}));
  const cafe: Place = {...ordinary[0]!, id: 'new-cafe', category: 'food', description: 'A neighborhood café.', taxonomy: ['urn:tag:genre:place:cafe']};
  const candidates = [...cultures, cafe];
  const previous = await prior(candidates, cultures.map(stop => stop.id));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (resource, init) => {
    assert.equal(new URL(String(resource)).hostname, 'api.openai.com');
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools[0].name, 'interpret_turn');
    const requestSchema = body.tools[0].parameters.properties.place_requests.items;
    assert.deepEqual(requestSchema.properties.scope.enum, ['plan', 'replacement']);
    assert.ok(requestSchema.required.includes('scope'), 'Production structured output always declares request scope');
    return tool('interpret_turn', wire({kind: 'adjust', replaceStopId: previous.stops[0]!.id, placeRequests: [
      {query: 'cafe', category: 'food', scope: 'replacement', minimum: 1, strength: 'preference'},
      {query: 'culture', category: 'culture', scope: 'plan', minimum: 2, strength: 'required'},
    ]}));
  };
  try {
    const result = await agentPlan({config, input, venue, candidates, previous, excludedIds: [], messages: [], request: {message: 'Replace the first stop with a café and keep at least two cultural stops'}});
    assert.ok(result.itinerary, result.clarification);
    assert.deepEqual(result.itinerary.stops.map(stop => stop.id), ['new-cafe', 'culture-1', 'culture-2']);
    assert.equal(result.memory.preferences.find(group => group.query === 'culture')!.minimum, 2);
    assert.equal(calls, 1, 'Scoped cached goals need only one semantic model call');
  } finally {globalThis.fetch = original;}
});
