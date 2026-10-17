import {isTerminalProviderFailure} from '../errors.js';
import {derivePlanningWindow} from '../../shared/planning-window.js';
import type { Itinerary, Place, PlanInput, StartingLocation, Venue, ChatMessage } from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import { checkPlan, suggestStopIds } from '../services/planner.js';
import { createRevisionMemory, rememberPlan } from '../services/revision-memory.js';
import { finalizePlan } from '../services/finalize-plan.js';
import { compactPlace, mergeCandidates, shortlist } from './planning-context.js';
import { enrichSelectedPlaces } from './qloo.js';
import { fetchJson, record, ServiceError } from './http.js';
import { initialCheckTool, initialInstructions, initialProposalSchema } from './planning-tools.js';
import type { WalkingRoute } from './walking.js';
import type { AgentPlanResult } from './openai.js';

export interface InitialPlanOptions {config: ServerConfig; input: PlanInput; venue: Venue; candidates: Place[]; startingLocation?: StartingLocation; messages: ChatMessage[]; excludedIds: string[]}
export async function createInitialPlan(options: InitialPlanOptions): Promise<AgentPlanResult> {
  const {config, input, venue, startingLocation} = options;
  const routeCache = new Map<string, WalkingRoute>();
  let candidates = options.candidates;
  let ids = suggestStopIds(input, venue, candidates, {}, undefined, startingLocation);
  candidates = mergeCandidates(candidates, await enrichSelectedPlaces(config, input.artist, venue, candidates.filter(place => ids.includes(place.id))));
  ids = suggestStopIds(input, venue, candidates, {}, undefined, startingLocation);
  const suggested = ids.length ? await checkPlan({ids, input, venue, candidates, mode: 'live', apiKey: config.googleMapsApiKey, routeCache, startingLocation}) : undefined;
  const context: unknown[] = [{role: 'user', content: JSON.stringify({input, planningWindow: derivePlanningWindow(input), venue: {name: venue.name, city: venue.city}, startingLocation,
    candidates: shortlist(candidates, ids).map(compactPlace), suggestedFeasibleIds: ids,
    checkedSuggestedPlan: suggested?.itinerary ? {stopIds: ids, totalWalkMinutes: suggested.itinerary.totalWalkMinutes, totalMinutes: suggested.itinerary.totalMinutes} : null,
  })}];
  let invalidArguments = false;
  for (let round = 0; round < 2; round++) {
    let body: Record<string, unknown>;
    try {body = record(await fetchJson('https://api.openai.com/v1/responses', {method: 'POST', headers: {Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: config.openaiModel, instructions: initialInstructions, input: context, tools: [initialCheckTool], tool_choice: {type: 'function', name: 'check_plan'},
        parallel_tool_calls: false, reasoning: {effort: config.openaiReasoningEffort}, include: ['reasoning.encrypted_content'], max_output_tokens: 3500, store: false}),
    }, 'Planning assistant', 35_000));}
    catch (error) {if (isTerminalProviderFailure(error)) throw error; if (error instanceof ServiceError && suggested?.itinerary) break; throw error;}
    const output = Array.isArray(body.output) ? body.output : [];
    const calls = output.map(record).filter(item => item.type === 'function_call');
    const call = calls[0];
    if (calls.length !== 1 || !call || call.name !== 'check_plan' || typeof call.arguments !== 'string' || typeof call.call_id !== 'string') {
      if (suggested?.itinerary) {invalidArguments = true; break;}
      throw new ServiceError('The planning assistant could not complete this request. Please try again.', 502, 'INVALID_PLAN_RESPONSE');
    }
    let raw: unknown;
    try {raw = JSON.parse(call.arguments);} catch {raw = undefined;}
    const parsed = initialProposalSchema.safeParse(raw);
    const issues = parsed.success ? [] : ['Initial plans accept only trusted stop_ids and grounded stop_notes; submitted constraints are server-owned.'];
    if (!parsed.success) invalidArguments = true;
    if (parsed.success && suggested?.itinerary && parsed.data.stop_ids.length < suggested.itinerary.stops.length) issues.push('A fuller verified outing already fits; use suggestedFeasibleIds.');
    const checked = parsed.success && !issues.length ? await checkPlan({ids: parsed.data.stop_ids, input, venue, candidates, mode: 'live', apiKey: config.googleMapsApiKey, routeCache, startingLocation}) : undefined;
    if (checked?.itinerary && parsed.success) {
      const final = await finalizePlan({...options, candidates, checked: checked.itinerary, preferences: {}, routeCache, notes: parsed.data.stop_notes});
      candidates = final.candidates;
      if (final.itinerary) return {itinerary: final.itinerary, candidates, excludedIds: [], memory: rememberPlan(createRevisionMemory(), final.itinerary)};
    }
    context.push(...output, {type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({valid: false, issues: [...issues, ...(checked?.issues ?? [])], suggestedIds: ids})});
  }
  if (suggested?.itinerary) {
    const final = await finalizePlan({...options, candidates, checked: suggested.itinerary, preferences: {}, routeCache});
    candidates = final.candidates;
    if (final.itinerary) return {itinerary: final.itinerary, candidates, excludedIds: [], memory: rememberPlan(createRevisionMemory(), final.itinerary)};
  }
  return {clarification: invalidArguments ? 'I could not complete your plan. Please try again.' : 'I could not fit nearby stops into the time and preferences you selected. Try allowing more time or choosing a starting point closer to the venue.', candidates, excludedIds: [], memory: createRevisionMemory()};
}
