import {derivePlanningWindow} from '../../shared/planning-window.js';
import type { ChatMessage, Itinerary, Place, PlanInput, RevisionInput, StartingLocation, Venue } from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import { planInputSchema } from '../validation.js';
import { checkPlan, suggestStopIds, type PlanPreferences } from '../services/planner.js';
import { createRevisionMemory, rememberPlan, samePlan, type PlacePreference, type RevisionMemory } from '../services/revision-memory.js';
import { applyPlaceScope, journeyMessage, stopCountLimit, validateTurnIntent, type TurnIntent } from '../services/journey-intent.js';
import { mergePlacePreference, resolvePlacePreferences } from '../services/place-preferences.js';
import { placeNames, refinementLimit } from '../services/revisions.js';
import { capacitySearchQueries } from '../services/capacity-discovery.js';
import { finalizePlan } from '../services/finalize-plan.js';
import { answerPlanQuestion } from './plan-answers.js';
import { interpretTurn } from './turn-intent.js';
import { compactPlace, mergeCandidates, shortlist } from './planning-context.js';
import { findPlaces, matchesPlacePreference } from './qloo.js';
import { diningMessage } from './dining-evidence.js';
import { executionCheckTool, executionFindTool, executionInstructions, executionSchema, executionSearchSchema } from './planning-tools.js';
import { cleanText, fetchJson, record, ServiceError } from './http.js';
import type { WalkingRoute } from './walking.js';
import type { AgentPlanResult } from './openai.js';

interface Requirement extends PlacePreference {turnSearch?: boolean; replacement?: boolean}
function samePreference(a: PlacePreference, b: Omit<PlacePreference, 'ids'>): boolean {
  return a.query.toLowerCase() === b.query.toLowerCase() && a.category === b.category && a.diningStyle === b.diningStyle &&
    a.recognition === b.recognition && Boolean(a.exclusive) === Boolean(b.exclusive);
}
export interface RevisionPlanOptions {config: ServerConfig; input: PlanInput; venue: Venue; candidates: Place[]; previous: Itinerary; request: RevisionInput;
  messages: ChatMessage[]; excludedIds: string[]; memory?: RevisionMemory; startingLocation?: StartingLocation; turnIntent?: TurnIntent}
function refreshRequirements(groups: Requirement[], candidates: Place[]) {
  for (const group of groups) group.ids = candidates.filter(place => matchesPlacePreference(place, group)).map(place => place.id);
}
/** Interpret once, execute against immutable goals, then accept only a fully checked result. */
export async function revisePlan(options: RevisionPlanOptions): Promise<AgentPlanResult> {
  const {config, previous, request} = options;
  const memory = options.memory ?? createRevisionMemory(previous);
  const intent = options.turnIntent ? validateTurnIntent(options.turnIntent, {message: request.message, currentCount: previous.stops.length, preferences: memory.preferences,
    trustedPlaceIds: [...options.candidates.map(place => place.id), ...memory.shown.map(place => place.id)], currentPlaceIds: previous.stops.map(stop => stop.id)})
    : await interpretTurn({config, previous, request, messages: options.messages, memory, candidateIds: options.candidates.map(place => place.id)});
  const unchanged = (clarification: string, candidates = options.candidates): AgentPlanResult => ({clarification: cleanText(clarification, 1000), excludedIds: options.excludedIds, candidates, memory});
  if (intent.kind === 'clarify') return unchanged(intent.clarification ?? 'What would you like to change about your outing?');
  if (intent.kind === 'answer') return unchanged(await answerPlanQuestion({config, previous, request, messages: options.messages, memory}));
  const startingLocation = options.startingLocation ?? previous.startingLocation;
  const stopCount = intent.stopCount === null ? undefined : intent.stopCount ?? memory.stopCount;
  const rebalances = intent.placeRequests.some(place => place.operation === 'increase');
  const planningCount = (rebalances || intent.replaceStopId) && intent.stopCount === undefined ? {minimum: previous.stops.length, maximum: previous.stops.length} : stopCount;
  const walkingLimit = intent.walking === 'clear_limit' ? undefined : memory.walkingLimit;
  const excludedIds = [...new Set([...options.excludedIds, ...intent.rejectIds, ...(intent.replaceStopId ? [intent.replaceStopId] : [])])].filter(id => !intent.restoreIds.includes(id)).slice(-80);
  const input = {...options.input};
  if (intent.showTimeUpdate !== 'unchanged') input.showTime = intent.showTimeUpdate;
  if (intent.durationUpdate !== 'unchanged') input.durationMinutes = intent.durationUpdate;
  if (intent.budgetUpdate === 'unset') delete input.budget; else if (intent.budgetUpdate !== 'unchanged') input.budget = intent.budgetUpdate;
  if (intent.arrivalUpdate === 'unset') delete input.arrivalBy; else if (intent.arrivalUpdate !== 'unchanged') input.arrivalBy = intent.arrivalUpdate;
  const parsedInput = planInputSchema.safeParse(input);
  if (!parsedInput.success) return unchanged(parsedInput.error.issues[0]?.message ?? 'Please check the requested time.');
  const groups: Requirement[] = applyPlaceScope(memory.preferences, intent).map(group => {
    if (!intent.keepPreferences.some(query => query.toLowerCase() === group.query.toLowerCase())) return group;
    // Scope promotion has already marked this group required; consult its accepted strength.
    const accepted = memory.preferences.find(preference => samePreference(preference, group));
    const requiredMinimum = accepted?.strength === 'required' || accepted?.exclusive ? accepted.minimum : 1;
    const currentMatches = previous.stops.filter(stop => stop.id !== intent.replaceStopId && matchesPlacePreference(stop, group)).length;
    if (intent.replaceStopId && !currentMatches && accepted && accepted.strength !== 'required' && !accepted.exclusive) return {...accepted, ids: [...accepted.ids]};
    return {...group, minimum: Math.max(requiredMinimum, currentMatches)};
  });
  for (const place of intent.placeRequests) {
    const {operation, scope, ...preference} = place;
    const replacement = Boolean(intent.replaceStopId && scope !== 'plan');
    const index = groups.findIndex(group => Boolean(group.replacement) === replacement && samePreference(group, preference));
    const existing = groups[index];
    const minimum = operation === 'increase' ? Math.min(planningCount?.maximum ?? 3, previous.stops.filter(stop => matchesPlacePreference(stop, {...preference, matchedTagIds: existing?.matchedTagIds})).length + 1) : place.minimum;
    const group: Requirement = {...preference, minimum, ids: [], turnSearch: true, ...(replacement ? {replacement: true} : {})};
    if (index >= 0) groups[index] = {...mergePlacePreference(groups[index], group, ''), turnSearch: true, ...(groups[index]!.replacement || group.replacement ? {replacement: true} : {})}; else groups.push(group);
  }
  let candidates = mergeCandidates(options.candidates, [], previous, groups.flatMap(group => group.ids));
  refreshRequirements(groups, candidates);
  const seenIds = memory.shown.map(place => place.id);
  const routeCache = new Map<string, WalkingRoute>();
  const wantsAlternatives = intent.kind === 'alternatives';
  const configurationOnly = intent.kind === 'adjust' && intent.placeScope === 'unchanged' && !intent.replaceStopId && !intent.placeRequests.length &&
    !intent.dropPreferences.length && !intent.keepPreferences.length && !intent.minimumChanges && !intent.rejectIds.length && !intent.restoreIds.length;
  const keepsEveryCurrentPlace = intent.keepStopIds.length === previous.stops.length;
  const routeLocked = keepsEveryCurrentPlace && (previous.stops.length === 3 || planningCount?.maximum === previous.stops.length);
  const preferencesNow = (): PlanPreferences => {
    const planGroups = groups.filter(group => !group.replacement);
    const base: PlanPreferences = {minimumStopCount: planningCount?.minimum, maximumStopCount: planningCount?.maximum,
      ...(planGroups.some(group => group.exclusive) ? {allowedPlaceIds: [...new Set(planGroups.filter(group => group.exclusive).flatMap(group => group.ids))]} : {}),
      excludeIds: excludedIds, replaceStopId: intent.replaceStopId, preferRetainedStops: rebalances, preferredWalkMinutes: walkingLimit, lessWalking: intent.walking === 'less', minimumChangedStops: intent.minimumChanges,
      preferMichelinCollection: groups.some(group => group.recognition === 'michelin'), preferHighEndDining: groups.some(group => group.diningStyle === 'high_end'),
      requiredPlaceGroups: [
        ...(intent.keepStopIds.length ? [{ids: intent.keepStopIds, minimum: intent.keepStopIds.length}] : []),
        ...(intent.restoreIds.length ? [{ids: intent.restoreIds, minimum: intent.restoreIds.length}] : []),
        ...(intent.replaceStopId ? groups.filter(group => group.replacement).map(group => ({ids: group.ids.filter(id => !previous.stops.some(stop => stop.id === id)), minimum: group.minimum, ...(group.maximum !== undefined ? {maximum: group.maximum} : {})})) : []),
      ]};
    const softFitPool = configurationOnly ? candidates.filter(place => previous.stops.some(stop => stop.id === place.id)) : candidates;
    const resolved = resolvePlacePreferences(planGroups, base, preference => suggestStopIds(input, options.venue, softFitPool, preference, previous, startingLocation).length > 0);
    if (wantsAlternatives || rebalances || intent.replaceStopId) {
      resolved.diversify = true; resolved.seenIds = seenIds;
      for (let fresh = Math.max(1, intent.minimumChanges); fresh >= 1; fresh--) {
        if (suggestStopIds(input, options.venue, candidates, {...resolved, minimumUnseenStops: fresh}, previous, startingLocation).length) {resolved.minimumUnseenStops = fresh; break;}
      }
    }
    return resolved;
  };
  const checkedSuggestion = async (preferences = preferencesNow()) => {
    const ids = suggestStopIds(input, options.venue, candidates, preferences, previous, startingLocation);
    return ids.length ? checkPlan({ids, input, venue: options.venue, candidates, previous, preferences, mode: 'live', apiKey: config.googleMapsApiKey, routeCache, startingLocation}) : undefined;
  };
  const accept = async (checked: Itinerary, preferences: PlanPreferences, notes: Parameters<typeof finalizePlan>[0]['notes'] = []): Promise<AgentPlanResult | undefined> => {
    const final = await finalizePlan({config, checked, input, venue: options.venue, candidates, previous, preferences, startingLocation, routeCache, notes, resolvePreferences: pool => {candidates = pool; refreshRequirements(groups, candidates); return preferencesNow();}});
    candidates = final.candidates;
    if (!final.itinerary) return undefined;
    const itinerary = samePlan(previous, final.itinerary) ? {...final.itinerary, revision: previous.revision} : final.itinerary;
    const acceptedWalking = intent.walking === 'less' ? Math.min(walkingLimit ?? Infinity, itinerary.totalWalkMinutes) : walkingLimit;
    const nextMemory = rememberPlan(memory, itinerary, groups.filter(group => !group.replacement).map(({turnSearch: _turn, replacement: _replacement, ...group}) => group), acceptedWalking, stopCount ?? null);
    if (acceptedWalking === undefined) delete nextMemory.walkingLimit;
    const matchingIds = new Set(groups.filter(group => group.turnSearch).flatMap(group => group.ids));
    const matchingStops = itinerary.stops.filter(stop => matchingIds.has(stop.id));
    const satisfied = samePlan(previous, itinerary) && matchingStops.length ? `Your plan already includes ${placeNames(matchingStops)}.` : undefined;
    const budgetSatisfied = samePlan(previous, itinerary) && intent.budgetUpdate !== 'unchanged' ? itinerary.input.budget ? `Your plan already fits your ${itinerary.input.budget} budget preference.` : 'Your plan has no budget preference.' : undefined;
    return {itinerary, candidates, excludedIds, memory: nextMemory,
      message: [satisfied, budgetSatisfied, journeyMessage({...intent, keepPreferences: intent.keepPreferences.filter(query => groups.some(group => group.strength === 'required' && group.query.toLowerCase() === query.toLowerCase()))}, itinerary), diningMessage(itinerary, intent.placeRequests.some(place => place.recognition === 'michelin'))].filter(Boolean).join(' ') || undefined};
  };
  // Current Michelin stars are outside the supplied place-data contract, even if a guide association exists.
  if (intent.placeRequests.some(place => place.recognition === 'michelin' && place.strength === 'required')) {
    const names = candidates.filter(place => place.diningEvidence?.fineDining).slice(0, 2).map(place => place.name).join(' or ');
    return unchanged(`I cannot verify current Michelin-star status from these place records. Your plan is unchanged.${names ? ` Fine-dining alternatives include ${names}; ask for fine dining without a verified-star requirement.` : ' Ask for fine dining without a verified-star requirement, or a named restaurant.'}`);
  }
  let preferences = preferencesNow();
  if (configurationOnly || routeLocked) {
    const retained = await checkPlan({ids: previous.stops.map(stop => stop.id), input, venue: options.venue, candidates, previous,
      preferences, mode: 'live', apiKey: config.googleMapsApiKey, routeCache, startingLocation});
    if (retained.itinerary) {
      const accepted = await accept(retained.itinerary, preferences);
      if (accepted) return accepted;
    } else if (keepsEveryCurrentPlace) {
      // Retention binds places, not an impossible order: try the bounded current-ID permutations.
      const keptPool = candidates.filter(place => intent.keepStopIds.includes(place.id));
      const reorderedIds = suggestStopIds(input, options.venue, keptPool, preferences, previous, startingLocation);
      const reordered = reorderedIds.length ? await checkPlan({ids: reorderedIds, input, venue: options.venue, candidates, previous,
        preferences, mode: 'live', apiKey: config.googleMapsApiKey, routeCache, startingLocation}) : undefined;
      if (reordered?.itinerary) {
        const accepted = await accept(reordered.itinerary, preferences);
        if (accepted) return accepted;
      }
      return unchanged(`I could not keep all of these places with that change. ${retained.issues[0] ?? 'The route does not fit your time and preferences.'} Your plan is unchanged. Adjust the preference or allow a place to change.`, candidates);
    }
  }
  let suggested = await checkedSuggestion(preferences);
  if (suggested?.itinerary && (!wantsAlternatives || preferences.minimumUnseenStops)) {
    const accepted = await accept(suggested.itinerary, preferences);
    if (accepted) return accepted;
  }
  let retrievals = 0;
  const searchedRequests = new Set<(typeof intent.placeRequests)[number]>();
  // Broader count goals need enough short visits, rather than another long meal or museum.
  // Search policy comes from the same duration/window model used by scheduling.
  const capacityQueries = !suggested?.itinerary && stopCount && !intent.placeRequests.some(place => place.minimum > 0 || place.operation === 'increase') && !intent.replaceStopId && intent.kind !== 'restore' && !groups.some(group => group.exclusive)
    ? capacitySearchQueries({input, venue: options.venue, startingLocation, minimumCount: stopCount.minimum, candidates}) : [];
  for (const query of capacityQueries.slice(0, 2)) {
    retrievals++;
    const found = await findPlaces(config, input.artist, options.venue, query, startingLocation);
    candidates = mergeCandidates(candidates, found.places, previous, groups.flatMap(group => group.ids));
    refreshRequirements(groups, candidates);
    preferences = preferencesNow(); suggested = await checkedSuggestion(preferences);
    if (suggested?.itinerary) {
      const accepted = await accept(suggested.itinerary, preferences);
      if (accepted) return accepted;
    }
  }
  const context: unknown[] = [{role: 'user', content: JSON.stringify({immutableIntent: intent, input, planningWindow: derivePlanningWindow(input),
    venue: {name: options.venue.name, city: options.venue.city}, startingLocation,
    activeTotalStops: planningCount ?? null, activePreferences: groups, preferredWalkMinutes: walkingLimit ?? null,
    candidates: shortlist(candidates.filter(place => !excludedIds.includes(place.id)), [...(suggested?.itinerary?.stops.map(stop => stop.id) ?? []), ...previous.stops.map(stop => stop.id)]).map(compactPlace),
    currentPlan: {stops: previous.stops.map(compactPlace), totalWalkMinutes: previous.totalWalkMinutes, totalMinutes: previous.totalMinutes},
    suggestedFeasibleIds: suggested?.itinerary?.stops.map(stop => stop.id) ?? [], checkedSuggestedPlan: suggested?.itinerary ? {stopIds: suggested.itinerary.stops.map(stop => stop.id), totalWalkMinutes: suggested.itinerary.totalWalkMinutes, totalMinutes: suggested.itinerary.totalMinutes} : null,
  })}];
  let forceSearch = !suggested?.itinerary || (wantsAlternatives && !preferences.minimumUnseenStops);
  for (let round = 0; round < (retrievals >= 2 ? 0 : 3); round++) {
    const canFind = retrievals < 2 && round < 2;
    const body = record(await fetchJson('https://api.openai.com/v1/responses', {method: 'POST', headers: {Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: config.openaiModel, instructions: executionInstructions, input: context, tools: canFind ? [executionFindTool, executionCheckTool] : [executionCheckTool],
        tool_choice: forceSearch && canFind ? {type: 'function', name: 'find_places'} : canFind ? 'required' : {type: 'function', name: 'check_plan'},
        parallel_tool_calls: false, reasoning: {effort: config.openaiReasoningEffort}, include: ['reasoning.encrypted_content'], max_output_tokens: 2500, store: false}),
    }, 'Planning assistant', 30_000));
    const output = Array.isArray(body.output) ? body.output : [];
    const calls = output.map(record).filter(item => item.type === 'function_call');
    const call = calls[0];
    if (calls.length !== 1 || !call || !['find_places', 'check_plan'].includes(String(call.name)) || typeof call.arguments !== 'string' || typeof call.call_id !== 'string') throw new ServiceError('The planning assistant could not complete this request. Please try again.');
    const feedback = (result: unknown) => context.push(...output, {type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result)});
    let raw: unknown;
    try {raw = JSON.parse(call.arguments);} catch {feedback({valid: false, issues: ['Use valid JSON matching the execution tool.'], immutableIntent: intent}); continue;}
    if (call.name === 'find_places') {
      const parsed = executionSearchSchema.safeParse(raw);
      if (!canFind || !parsed.success) {feedback({valid: false, issues: ['Use one short place query while a search remains.'], immutableIntent: intent}); continue;}
      const discoverableRequests = intent.placeRequests.filter(place => place.maximum !== 0);
      const matchingRequests = parsed.data.preference_query ? discoverableRequests.filter(place => place.query.toLowerCase() === parsed.data.preference_query!.toLowerCase()) : discoverableRequests.length === 1 ? discoverableRequests : [];
      const pendingRequests = matchingRequests.filter(place => {
        if (intent.replaceStopId && place.scope !== 'plan') return true;
        const group = groups.find(item => samePreference(item, place));
        return previous.stops.filter(stop => matchesPlacePreference(stop, {...place, matchedTagIds: group?.matchedTagIds})).length < (group?.minimum ?? place.minimum);
      }).sort((a, b) => Number(Boolean(intent.replaceStopId && b.scope !== 'plan')) - Number(Boolean(intent.replaceStopId && a.scope !== 'plan')));
      const searchRequests = pendingRequests.length ? pendingRequests : matchingRequests;
      const bound = searchRequests.find(place => !searchedRequests.has(place)) ?? searchRequests[0];
      if (parsed.data.preference_query && !bound) {feedback({valid: false, issues: ['Bind searches only to an exact positive requested-place query, or use null to explore alternatives. Do not search for an excluded kind.']}); continue;}
      retrievals++; forceSearch = false;
      if (bound) searchedRequests.add(bound);
      const found = await findPlaces(config, input.artist, options.venue, bound?.query ?? parsed.data.query, startingLocation, {diningStyle: bound?.diningStyle, recognition: bound?.recognition});
      if (bound) {
        for (const group of groups.filter(item => samePreference(item, bound))) group.matchedTagIds = found.matchedTagIds;
      }
      candidates = mergeCandidates(candidates, found.places, previous, groups.flatMap(group => group.ids));
      refreshRequirements(groups, candidates);
      preferences = preferencesNow(); suggested = await checkedSuggestion(preferences);
      if (suggested?.itinerary && (!wantsAlternatives || preferences.minimumUnseenStops || retrievals >= 1)) {
        const accepted = await accept(suggested.itinerary, preferences);
        if (accepted) return accepted;
      }
      if (retrievals >= 2 && !suggested?.itinerary) break;
      feedback({query: found.query, matches: found.places.map(compactPlace), activePreferences: groups, immutableIntent: intent,
        suggestedIds: suggested?.itinerary?.stops.map(stop => stop.id) ?? [], instruction: found.places.length ? 'Use these trusted facts. Search another kind if the complete goal still cannot fit.' : 'No matches; try one other grounded query if a search remains.'});
      forceSearch = !suggested?.itinerary;
      continue;
    }
    const parsed = executionSchema.safeParse(raw);
    if (!parsed.success) {feedback({valid: false, issues: ['Use stop_ids, grounded stop_notes and an optional concrete clarification.'], immutableIntent: intent}); continue;}
    preferences = preferencesNow(); suggested = await checkedSuggestion(preferences);
    if (suggested?.itinerary && (!wantsAlternatives || preferences.minimumUnseenStops || retrievals >= 1)) {
      // Server scheduling already proves the complete immutable goal; do not spend repair rounds recreating it.
      const accepted = await accept(suggested.itinerary, preferences, parsed.data.stop_notes);
      if (accepted) return accepted;
    }
    const checked = parsed.data.clarification ? undefined : await checkPlan({ids: parsed.data.stop_ids, input, venue: options.venue, candidates, previous, preferences, mode: 'live', apiKey: config.googleMapsApiKey, routeCache, startingLocation});
    if (checked?.itinerary && (!wantsAlternatives || retrievals >= 1 || preferences.minimumUnseenStops)) {
      const accepted = await accept(checked.itinerary, preferences, parsed.data.stop_notes);
      if (accepted) return accepted;
    }
    if (canFind) forceSearch = true;
    feedback({valid: false, issues: checked?.issues ?? ['The complete immutable goal is not yet met. Search for real candidates before claiming a limit.'], immutableIntent: intent});
  }
  if (intent.replaceStopId) {
    const target = previous.stops.find(stop => stop.id === intent.replaceStopId)!;
    return unchanged(`I could not find a replacement for ${target.name} that keeps the rest of your route in place and fits your time and preferences. Your plan is unchanged. Try another kind of place or adjust a preference.`, candidates);
  }
  if (stopCount && (intent.stopCount || !groups.some(group => group.turnSearch))) {
    const withoutCount = {...preferencesNow(), minimumStopCount: undefined, maximumStopCount: undefined};
    const ids = suggestStopIds(input, options.venue, candidates, withoutCount, previous, startingLocation);
    const feasible = ids.length ? await checkPlan({ids, input, venue: options.venue, candidates, previous, preferences: withoutCount, mode: 'live', apiKey: config.googleMapsApiKey, routeCache, startingLocation}) : undefined;
    return unchanged(stopCountLimit(stopCount, input, options.venue, startingLocation, feasible?.itinerary?.stops.length ?? 0), candidates);
  }
  return unchanged(groups.some(group => group.turnSearch) ? refinementLimit(groups, input, options.venue, startingLocation, previous, candidates) : 'I could not fit that change with the verified nearby places and your current requirements. Your plan is unchanged. Try allowing more time or adjusting a preference.', candidates);
}
