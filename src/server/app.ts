import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import staticFiles from '@fastify/static';
import { registerSecurity } from './security.js';
import {registerCanonicalOrigin} from './canonical-origin.js';
import { createSessions } from './sessions.js';
import {createStateStore, type StateStore} from './storage/index.js';
import { registerRoutes } from './routes.js';
import {registerSharedRoutes} from './shared-routes.js';
import {registerSharedPageRoutes} from './shared-page-routes.js';
import {registerSeoRoutes} from './seo-routes.js';
import {sendHomepageHtml} from './services/site-seo.js';
import type { ServerConfig } from './config.js';
import { ServiceError } from './providers/http.js';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    if (status >= 500) app.log.error({ requestId: request.id, code: error.code || 'UNEXPECTED_ERROR' }, 'Request failed');
    const message = error instanceof ServiceError || status < 500 ? error.message : 'Something interrupted this request. Please try again.';
    reply.code(status).send({ error: status === 413 ? 'That request is too large.' : message, code: error.code || 'REQUEST_FAILED' });
  });
}

export function createHttpServer(config: ServerConfig) {
  const app = Fastify({
    logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', '*.apiKey'] },
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16384,
    trustProxy: config.production ? (_address: string, hop: number) => hop < 1 : false,
    requestTimeout: 60000, connectionTimeout: 0,
  });
  // Fastify captures the active error handler when each route is registered.
  registerErrorHandler(app);
  registerCanonicalOrigin(app, config);
  return app;
}

export async function createApp(config: ServerConfig, development = false, options: {store?: StateStore} = {}) {
  const app = createHttpServer(config);
  const store = options.store ?? await createStateStore(config);
  const sessions = createSessions(config, store);
  if (!options.store) app.addHook('onClose', async () => {await store.close?.();});
  await registerSecurity(app, config, development, store);
  await registerRoutes(app, {config, getSession: sessions, sessions});
  await registerSharedRoutes(app, sessions, store);
  app.get('/healthz', async () => ({ status: 'ok' }));
  if (development) {
    const [{ createServer }, { default: middie }] = await Promise.all([import('vite'), import('@fastify/middie')]);
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
    await app.register(middie);
    app.use(vite.middlewares);
    const template = async (url: string) => vite.transformIndexHtml(url, await readFile(resolve('index.html'), 'utf8'));
    await registerSharedPageRoutes(app, {config, store, template});
    await registerSeoRoutes(app, {config, template});
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive').code(404).send({ error: 'That endpoint does not exist.' });
      return sendHomepageHtml(reply, await template(request.url), config, 404);
    });
    app.addHook('onClose', async () => { await vite.close(); });
  } else {
    await app.register(staticFiles, {
      root: resolve('dist/client'), wildcard: false, preCompressed: true, index: false, globIgnore: ['index.html', 'index.html.br', 'index.html.gz'],
      setHeaders(response, filePath) { response.header('Cache-Control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'); },
    });
    let sharedTemplate: Promise<string> | undefined;
    const template = async (_url: string) => sharedTemplate ??= readFile(resolve('dist/client/index.html'), 'utf8');
    await registerSharedPageRoutes(app, {config, store, template});
    await registerSeoRoutes(app, {config, template});
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive').code(404).send({ error: 'That endpoint does not exist.' });
      return sendHomepageHtml(reply, await template(request.url), config, 404);
    });
  }
  return app;
}
