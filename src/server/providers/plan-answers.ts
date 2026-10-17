import {derivePlanningWindow} from '../../shared/planning-window.js';
import type { ChatMessage, Itinerary, RevisionInput } from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import type { RevisionMemory } from '../services/revision-memory.js';
import { cleanText, fetchJson, record, ServiceError } from './http.js';
import { answerTool, answerInstructions, planAnswerSchema } from './planning-tools.js';

interface PlanAnswerOptions {
  config: ServerConfig; previous: Itinerary; request: RevisionInput; messages: ChatMessage[]; memory: RevisionMemory;
}
/** Answer from existing plan facts with no discovery or mutation capability. */
export async function answerPlanQuestion({config, previous, request, messages, memory}: PlanAnswerOptions): Promise<string> {
  const body = record(await fetchJson('https://api.openai.com/v1/responses', {
    method: 'POST', headers: {Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({model: config.openaiModel, instructions: answerInstructions, input: [{role: 'user', content: JSON.stringify({
      request: request.message, recentConversation: messages.slice(-8),
      currentPlan: {input: previous.input, activeSettings: {budgetFiltering: previous.input.budget !== undefined, budget: previous.input.budget ?? null, arrivalBy: previous.input.arrivalBy ?? null}, planningWindow: derivePlanningWindow(previous.input), venue: previous.venue.name, startingLocation: previous.startingLocation?.name ?? previous.venue.name,
        totalWalkMinutes: previous.totalWalkMinutes, totalMinutes: previous.totalMinutes, estimatedArrival: previous.estimatedArrival, estimatedArrivalDate: previous.estimatedArrivalDate,
        michelinStarStatus: 'unverified', notices: previous.notices,
        stops: previous.stops.map(stop => ({id: stop.id, name: stop.name, category: stop.category, description: stop.description,
          taxonomy: stop.taxonomy, localNote: stop.localNote, recommendation: stop.recommendation, affinity: stop.affinity,
          costTier: stop.costTier, diningEvidence: stop.diningEvidence,
          address: stop.address, neighborhood: stop.neighborhood, phone: stop.phone, openingHours: stop.openingHours, source: stop.source,
          durationMinutes: stop.durationMinutes, walkMinutes: stop.walkMinutes, arrivalTime: stop.arrivalTime, departureTime: stop.departureTime, arrivalDate: stop.arrivalDate, departureDate: stop.departureDate})),
      }, activeTotalStops: memory.stopCount ?? null, activePreferences: memory.preferences.map(({query, minimum, maximum, strength, exclusive, diningStyle, recognition}) => ({query, minimum, maximum, strength: strength ?? 'preference', exclusive, diningStyle, recognition})), preferredWalkMinutes: memory.walkingLimit,
    })}], tools: [answerTool], tool_choice: {type: 'function', name: 'answer_plan'}, parallel_tool_calls: false,
      reasoning: {effort: config.openaiReasoningEffort}, max_output_tokens: 1800, store: false}),
  }, 'Planning assistant', 20_000));
  const calls = (Array.isArray(body.output) ? body.output : []).map(record).filter(item => item.type === 'function_call');
  let raw: unknown;
  try { raw = calls.length === 1 && calls[0]!.name === 'answer_plan' && typeof calls[0]!.arguments === 'string' ? JSON.parse(calls[0]!.arguments) : undefined; } catch { raw = undefined; }
  const parsed = planAnswerSchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError('I could not answer that question right now. Please try again.');
  return cleanText(parsed.data.answer, 1000);
}
