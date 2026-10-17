import type { Itinerary, Place, PlanInput, RevisionInput, Venue, ChatMessage, StartingLocation } from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import type { RevisionMemory } from '../services/revision-memory.js';
import type { TurnIntent } from '../services/journey-intent.js';
import { replaceStop } from '../services/stop-replacement.js';
import { ServiceError } from './http.js';
import { createInitialPlan } from './initial-plan.js';
import { revisePlan } from './revision-plan.js';

export interface AgentPlanResult {itinerary?: Itinerary; clarification?: string; excludedIds: string[]; candidates: Place[]; memory: RevisionMemory; message?: string}
export async function agentPlan(options: {config: ServerConfig; input: PlanInput; venue: Venue; candidates: Place[];
  previous?: Itinerary; request?: RevisionInput; messages: ChatMessage[]; excludedIds: string[]; memory?: RevisionMemory; startingLocation?: StartingLocation;
  /** Trusted internal semantic boundary; never accepted from the public request body. */
  turnIntent?: TurnIntent;
}): Promise<AgentPlanResult> {
  if (options.request?.replaceStopId && options.previous) return replaceStop({...options, previous: options.previous, replaceStopId: options.request.replaceStopId});
  if (!options.config.openaiApiKey) throw new ServiceError('The planning assistant is not configured.', 503, 'NOT_CONFIGURED');
  if (!options.previous && !options.request) return createInitialPlan(options);
  if (!options.previous || !options.request) throw new ServiceError('Create an outing before changing it.', 400, 'PLAN_NOT_FOUND');
  return revisePlan({...options, previous: options.previous, request: options.request});
}
