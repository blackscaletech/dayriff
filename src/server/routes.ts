import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig, Artist, ChatMessage, City, Itinerary, Place, Venue, VenueSearchResult } from '../shared/types.js';
import type { ServerConfig } from './config.js';
import type {Sessions} from './sessions.js';
import type {SharedTripSnapshot} from './services/shared-trips.js';
import { CHAT_HISTORY_LIMIT } from '../shared/chat.js';
import { sampleArtists, sampleCities, samplePlaces, sampleVenues } from './data/catalog.js';
import { agentPlan } from './providers/openai.js';
import { searchArtists } from './providers/qloo.js';
import {discoverInitialPlaces} from './providers/initial-discovery.js';
import {resolveSelectedEntities} from './providers/selected-entities.js';
import { searchConcertLocations } from './providers/concert-search.js';
import { ServiceError } from './providers/http.js';
import { resolveStartingLocation } from './providers/starting-location.js';
import { checkPlan, suggestStopIds } from './services/planner.js';
import { asksForAlternatives, revisionSummary, sampleRevision } from './services/revisions.js';
import { explicitlyRequired, mergePlacePreference, resolvePlacePreferences, retainRequestedPreferences } from './services/place-preferences.js';
import { capturePlan, planHistory, rememberVersion, type PlanSnapshot } from './services/plan-history.js';
import { createRevisionMemory, rememberPlan, samePlan, type RevisionMemory } from './services/revision-memory.js';
import {assertPlanActive, withPlanDeadline} from './services/operation-deadline.js';
import { planIdSchema, planInputSchema, revisionSchema, searchSchema, venueSearchSchema, restoreSchema, historyDeleteParamsSchema } from './validation.js';

export interface SessionState {
  shares?: SharedTripSnapshot[];
  itinerary?: Itinerary; candidates?: Place[]; messages: ChatMessage[];
  artists: Artist[]; venues: Venue[]; cities: City[]; excludedIds: string[]; history: PlanSnapshot[]; busy?: boolean; memory?: RevisionMemory;
}
export interface RouteDependencies {
  config: ServerConfig;
  getSession(request: FastifyRequest, reply: FastifyReply): SessionState | Promise<SessionState>;
  sessions?: Sessions;
}
function remember<T extends {id: string}>(current: T[], next: T[]): T[] {
  const combined = new Map(current.map(item => [item.id, item]));
  for (const item of next) { combined.delete(item.id); combined.set(item.id, item); }
  return [...combined.values()].slice(-40);
}
function invalid(message: string): never { throw new ServiceError(message, 400, 'INVALID_INPUT'); }
function parse<T>(schema: {safeParse(value: unknown): {success: true; data: T} | {success: false; error: {issues: {message: string}[]}}}, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid(result.error.issues[0]?.message ?? 'Check the supplied details.');
  return result.data;
}
function addConversation(session: SessionState, user: string, assistant: string) {
  session.messages.push({role: 'user', text: user}, {role: 'assistant', text: assistant});
  session.messages = session.messages.slice(-CHAT_HISTORY_LIMIT);
}
async function exclusive<T>(session: SessionState, task: () => Promise<T>): Promise<T> {
  if (session.busy) throw new ServiceError('Your plan is already being updated. Please wait a moment.', 409, 'PLAN_BUSY');
  const hadBusy = Object.hasOwn(session, 'busy'), previousBusy = session.busy;
  session.busy = true;
  try { return await withPlanDeadline(task); }
  finally {if (hadBusy) session.busy = previousBusy; else delete session.busy;}
}
export async function registerRoutes(app: FastifyInstance, {config, getSession, sessions}: RouteDependencies) {
  const mutate = <T>(request: FastifyRequest, reply: FastifyReply, state: SessionState, task: (draft: SessionState) => Promise<T>) =>
    sessions ? sessions.mutate(request, reply, draft => exclusive(draft, () => task(draft))) : exclusive(state, () => task(state));
  app.delete('/api/session', async (request, reply) => {
    if (!sessions) throw new ServiceError('Trip clearing is temporarily unavailable.', 503, 'STORAGE_UNAVAILABLE');
    await sessions.clear(request, reply);
    return {cleared: true};
  });
  app.get('/api/config', async (): Promise<AppConfig> => ({mode: config.mode,
    venues: config.mode === 'sample' ? sampleVenues : [], sampleArtists: config.mode === 'sample' ? sampleArtists : [], liveChat: config.mode === 'live'}));
  app.get('/api/session', async (request, reply) => {
    const session = await getSession(request, reply);
    return {itinerary: session.itinerary ?? null, messages: session.messages, history: planHistory(session.history)};
  });
  app.get('/api/artists', async (request, reply) => {
    const {q} = parse(searchSchema, request.query);
    const session = await getSession(request, reply);
    const artists = config.mode === 'sample' ? sampleArtists.filter(artist => artist.name.toLowerCase().includes(q.toLowerCase())) : await searchArtists(config, q);
    session.artists = remember(session.artists, artists);
    await sessions?.update(request, reply, session);
    return {artists};
  });
  app.get('/api/venues', async (request, reply): Promise<VenueSearchResult> => {
    const {q, cityId} = parse(venueSearchSchema, request.query);
    const session = await getSession(request, reply);
    const city = cityId ? (config.mode === 'sample' ? sampleCities : session.cities).find(item => item.id === cityId.toLowerCase()) : undefined;
    if (cityId && !city) invalid('Search for your city again to choose a venue there.');
    const result = config.mode === 'sample' ? {
      cities: city ? [] : sampleCities.filter(item => `${item.name} ${item.region ?? ''} ${item.country ?? ''}`.toLowerCase().includes(q.toLowerCase())),
      venues: sampleVenues.filter(venue => (!city || venue.city === city.name) && (!q || `${venue.name} ${venue.city}`.toLowerCase().includes(q.toLowerCase()))),
    } : await searchConcertLocations(config, q, city);
    session.cities = remember(session.cities, result.cities);
    session.venues = remember(session.venues, result.venues);
    await sessions?.update(request, reply, session);
    return result;
  });
  app.post('/api/plans', async (request, reply) => {
    const submitted = parse(planInputSchema, request.body);
    const session = await getSession(request, reply);
    return mutate(request, reply, session, async session => {
      const {artist, venue} = config.mode === 'sample' ? {artist: sampleArtists.find(item => item.id === submitted.artist.id.toLowerCase()), venue: sampleVenues.find(item => item.id === submitted.venueId.toLowerCase())} : await resolveSelectedEntities(config, submitted, session);
      if (config.mode === 'live' && artist && venue) {session.artists = remember(session.artists, [artist]); session.venues = remember(session.venues, [venue]);}
      if (!artist || !venue) invalid('Choose an artist and a venue from the search suggestions, then try again.');
      const input = {...submitted, artist};
      const startingLocation = await resolveStartingLocation(config, input.startingPoint, venue);
      // Client-provided names, coordinates, candidate lists, prices and source URLs are never used.
      let candidates = config.mode === 'sample' ? samplePlaces : await discoverInitialPlaces(config, input, venue, startingLocation);
      if (!candidates.length) throw new ServiceError('We could not find enough verified place information for this area. Try another starting area or concert venue.', 422, 'NO_PLACES');
      let itinerary: Itinerary | undefined;
      let memory = createRevisionMemory();
      if (config.mode === 'sample') {
        const ids = suggestStopIds(input, venue, candidates, {}, undefined, startingLocation);
        const result = await checkPlan({ids, input, venue, candidates, mode: 'sample', startingLocation});
        itinerary = result.itinerary;
      } else {
        const result = await agentPlan({config, input, venue, startingLocation, candidates, messages: [], excludedIds: [], memory});
        if (result.clarification) throw new ServiceError(result.clarification, 422, 'NEEDS_DETAILS');
        itinerary = result.itinerary;
        candidates = result.candidates;
        memory = result.memory;
      }
      if (!itinerary) throw new ServiceError('No outing fits those times and preferences. Try more time or leave the optional constraints empty.', 422, 'NO_FEASIBLE_PLAN');
      assertPlanActive();
      session.itinerary = itinerary;
      session.memory = config.mode === 'sample' ? rememberPlan(memory, itinerary) : memory;
      session.candidates = candidates;
      session.excludedIds = [];
      session.history = [];
      session.messages = [];
      const message = revisionSummary(undefined, itinerary);
      session.messages.push({role: 'assistant', text: message});
      return {itinerary, message, history: planHistory(session.history)};
    });
  });
  app.post('/api/plans/:id/revise', async (request, reply) => {
    const {id} = parse(planIdSchema, request.params);
    const revision = parse(revisionSchema, request.body);
    const session = await getSession(request, reply);
    return mutate(request, reply, session, async session => {
      const previous = session.itinerary;
      if (!previous || previous.id !== id || !session.candidates) throw new ServiceError('This plan has expired. Create a new outing to continue.', 404, 'PLAN_NOT_FOUND');
      const snapshot = capturePlan(previous, session.memory, session.excludedIds);
      let itinerary: Itinerary | undefined;
      let clarification: string | undefined;
      let refinementMessage: string | undefined;
      let excludedIds = session.excludedIds;
      let memory = session.memory ?? createRevisionMemory(previous);
      if (config.mode === 'sample') {
        const intent = sampleRevision(previous, revision, session.excludedIds);
        clarification = intent.clarification;
        if (!clarification) {
          intent.preferences.preferredWalkMinutes = memory.walkingLimit;
          intent.preferences.minimumStopCount = memory.stopCount?.minimum;
          intent.preferences.maximumStopCount = memory.stopCount?.maximum;
          if (memory.preferences.some(group => group.exclusive)) intent.preferences.allowedPlaceIds = [...new Set(memory.preferences.filter(group => group.exclusive).flatMap(group => group.ids))];
          const remembered = retainRequestedPreferences(memory.preferences, revision.message, previous.stops);
          Object.assign(intent.preferences, resolvePlacePreferences(remembered, intent.preferences, preference => suggestStopIds(intent.input, previous.venue, session.candidates!, preference, previous).length > 0));
          if (revision.replaceStopId || asksForAlternatives(revision.message)) {
            intent.preferences.diversify = true;
            intent.preferences.minimumChangedStops = 1;
            intent.preferences.seenIds = memory.shown.map(place => place.id);
            if (suggestStopIds(intent.input, previous.venue, session.candidates, {...intent.preferences, minimumUnseenStops: 1}, previous).length) intent.preferences.minimumUnseenStops = 1;
          }
          const ids = suggestStopIds(intent.input, previous.venue, session.candidates, intent.preferences, previous);
          const checked = await checkPlan({ids, input: intent.input, venue: previous.venue, candidates: session.candidates, mode: 'sample', previous, preferences: intent.preferences});
          itinerary = checked.itinerary;
          if (itinerary) {
            excludedIds = intent.preferences.excludeIds ?? session.excludedIds;
            const preferences = [...remembered];
            if (intent.preferences.category) {
              const category = intent.preferences.category;
              const group = {query: category, category, strength: explicitlyRequired(revision.message, category, category) ? 'required' as const : 'preference' as const, minimum: intent.preferences.minimumCategoryCount ?? 1, ids: session.candidates.filter(place => place.category === category).map(place => place.id)};
              const index = preferences.findIndex(item => item.category === category);
              if (index >= 0) preferences[index] = mergePlacePreference(preferences[index], group, revision.message); else preferences.push(group);
            }
            memory = rememberPlan(memory, itinerary, preferences, intent.preferences.lessWalking ? Math.min(memory.walkingLimit ?? Infinity, itinerary.totalWalkMinutes) : memory.walkingLimit);
          }
          else clarification = 'I could not fit that change with the available sample places. Try a longer outing, a later arrival time, or another preference.';
        }
      } else {
        const result = await agentPlan({config, input: previous.input, venue: previous.venue, startingLocation: previous.startingLocation, candidates: session.candidates,
          previous, request: revision, messages: session.messages, excludedIds: session.excludedIds, memory});
        itinerary = result.itinerary;
        clarification = result.clarification;
        refinementMessage = result.message;
        excludedIds = result.excludedIds;
        assertPlanActive();
        session.candidates = result.candidates;
        memory = result.memory;
      }
      if (clarification || !itinerary) {
        const message = clarification ?? 'Please rephrase that change so I can update your plan.';
        addConversation(session, revision.message, message);
        return {itinerary: previous, message, history: planHistory(session.history)};
      }
      const changed = !samePlan(previous, itinerary);
      const message = [changed || !refinementMessage ? revisionSummary(previous, itinerary) : undefined, refinementMessage].filter(Boolean).join(' ');
      if (changed) session.history = rememberVersion(session.history, snapshot);
      assertPlanActive();
      session.itinerary = itinerary;
      session.excludedIds = excludedIds;
      session.memory = memory;
      addConversation(session, revision.message, message);
      return {itinerary, message, history: planHistory(session.history)};
    });
  });
  app.delete('/api/plans/:id/history/:versionId', async (request, reply) => {
    const {id, versionId} = parse(historyDeleteParamsSchema, request.params);
    const session = await getSession(request, reply);
    return mutate(request, reply, session, async session => {
      if (!session.itinerary || session.itinerary.id !== id) throw new ServiceError('This plan has expired. Create a new outing to continue.', 404, 'PLAN_NOT_FOUND');
      session.history = session.history.filter(version => version.id !== versionId || version.itinerary.id !== id);
      return {history: planHistory(session.history)};
    });
  });
  app.post('/api/plans/:id/restore', async (request, reply) => {
    const {id} = parse(planIdSchema, request.params);
    const {versionId} = parse(restoreSchema, request.body);
    const session = await getSession(request, reply);
    return mutate(request, reply, session, async session => {
      const current = session.itinerary;
      if (!current || current.id !== id) throw new ServiceError('This plan has expired. Create a new outing to continue.', 404, 'PLAN_NOT_FOUND');
      const saved = session.history.find(version => version.id === versionId);
      if (!saved) throw new ServiceError('That earlier plan is no longer available.', 404, 'VERSION_NOT_FOUND');
      const snapshot = capturePlan(current, session.memory, session.excludedIds);
      const itinerary = {...structuredClone(saved.itinerary), id: current.id, revision: current.revision + 1};
      session.history = rememberVersion(session.history.filter(version => version.id !== versionId), snapshot);
      assertPlanActive();
      session.itinerary = itinerary;
      session.excludedIds = [...saved.excludedIds];
      const memory = session.memory ?? createRevisionMemory(current);
      session.memory = rememberPlan(memory, itinerary, saved.preferences, saved.walkingLimit, saved.stopCount ?? null);
      if (saved.walkingLimit === undefined) delete session.memory.walkingLimit;
      session.candidates = [...new Map([...itinerary.stops, ...(session.candidates ?? [])].map(place => [place.id, place])).values()].slice(0, 40);
      const message = `Restored ${itinerary.stops.map(stop => stop.name).join(' → ')}.`;
      addConversation(session, 'Use this earlier plan', message);
      return {itinerary, message, history: planHistory(session.history)};
    });
  });

}
