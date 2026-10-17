import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Sessions} from './sessions.js';
import type {StateStore} from './storage/index.js';
import {createSharedTrips} from './services/shared-trips.js';
import {ServiceError} from './errors.js';

const shareRequest = z.object({revision: z.number().int().nonnegative()}).strict();

/** Sharing uses saved verified facts only; no provider or paid routing calls. */
export async function registerSharedRoutes(app: FastifyInstance, sessions: Sessions, store: StateStore) {
  const sharing = createSharedTrips(store);
  app.addHook('onSend', async (request, reply, payload) => {
    if (/^\/(?:api\/)?shared(?:\/|\?|$)/.test(request.url)) {
      reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    }
    return payload;
  });
  app.post<{Params: {id: string}}>('/api/plans/:id/share', async (request, reply) => {
    const submitted = shareRequest.safeParse(request.body);
    if (!submitted.success) throw new ServiceError('Reopen the share preview for your current plan, then try again.', 400, 'INVALID_INPUT');
    const ownerId = await sessions.identity(request, reply);
    return sessions.mutate(request, reply, async state => {
      if (!state.itinerary || state.itinerary.id !== request.params.id) throw new ServiceError('This plan is no longer available. Reopen your current trip before sharing.', 404, 'PLAN_NOT_FOUND');
      if (state.itinerary.revision !== submitted.data.revision) throw new ServiceError('This trip changed in another window. Your saved plan is safe; reopen it before trying again.', 409, 'PLAN_CHANGED');
      return sharing.publish(state, ownerId);
    });
  });
  app.get<{Params: {token: string}}>('/api/shared/:token', async request => {
    // Public capability links never create sessions or renew the owner's retention.
    return sharing.read(request.params.token);
  });
}
