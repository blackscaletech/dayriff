import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {ServerConfig} from './config.js';
import type {StateStore} from './storage/index.js';
import {createSharedTrips} from './services/shared-trips.js';
import {renderSharedPage, sharedPageMetadata, sharedPageOrigin} from './services/shared-page.js';
import {ServiceError} from './errors.js';

export async function registerSharedPageRoutes(app: FastifyInstance, {config, store, template}: {
  config: ServerConfig; store: StateStore; template: (url: string) => Promise<string>;
}) {
  const sharing = createSharedTrips(store);
  async function page(request: FastifyRequest, reply: FastifyReply, token?: string) {
    const origin = sharedPageOrigin(config, request);
    let plan, status = 404;
    if (token) {
      try {plan = (await sharing.read(token)).itinerary; status = 200;}
      catch (error) {if (!(error instanceof ServiceError) || error.code !== 'SHARE_NOT_FOUND') throw error;}
    }
    const html = renderSharedPage(await template(request.url), sharedPageMetadata(origin, token, plan));
    return reply.code(status).type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
  }
  app.get<{Params: {token: string}}>('/shared/:token', async (request, reply) => page(request, reply, request.params.token));
  app.get('/shared', async (request, reply) => page(request, reply));
  app.get('/shared/*', async (request, reply) => page(request, reply));
}
