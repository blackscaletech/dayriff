import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import type { ServerConfig } from './config.js';
import {createHmac} from 'node:crypto';
import {ServiceError} from './errors.js';
import {SESSION_COOKIE_NAME} from './sessions.js';
import {createQuotas, withProviderQuotas} from './services/quotas.js';
import {createMemoryStateStore, type StateStore} from './storage/state-store.js';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function isMutation(method: string): boolean {return mutationMethods.has(method);}

export async function registerSecurity(app: FastifyInstance, config: ServerConfig, development: boolean, store?: StateStore) {
  if (!store && config.production) throw new Error('Production quotas require shared durable storage.');
  const quotas = createQuotas(config, store ?? createMemoryStateStore());
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/')) return;
    const handler = route.handler;
    route.handler = function (request, reply) {return withProviderQuotas(quotas, () => handler.call(this, request, reply));};
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode === 429 && !reply.hasHeader('Retry-After')) reply.header('Retry-After', Math.max(1, Math.ceil((86_400_000 - Date.now() % 86_400_000) / 1000)));
    return payload;
  });
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"],
        styleSrc: development ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'], fontSrc: ["'self'"],
        connectSrc: development ? ["'self'", 'ws://localhost:*', 'ws://127.0.0.1:*'] : ["'self'"],
        objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.production ? { maxAge: 15552000, includeSubDomains: false } : false,
  });
  await app.register(rateLimit, {
    global: true, max: request => isMutation(request.method) ? 10 : 120,
    timeWindow: '1 minute',
    keyGenerator: request => `${request.ip}:${isMutation(request.method) ? 'mutation' : 'read'}`,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Too Many Requests', message: 'A little too fast. Please wait a minute and try again.', code: 'RATE_LIMITED' }),
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path?.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const origin = request.headers.origin;
    const expected = config.appOrigin || `${request.protocol}://${request.headers.host}`;
    if (request.headers['sec-fetch-site'] === 'cross-site' || (isMutation(request.method) && (request.headers['x-dayriff-request'] !== '1' || (origin && origin !== expected)))) {
      return reply.code(403).send({error: 'Please make this request from Dayriff.', code: 'FORBIDDEN'});
    }
    try {
      if (request.method === 'GET' && (path === '/api/artists' || path === '/api/venues')) await quotas.reserveLookup();
      if (request.method === 'POST' && (path === '/api/plans' || /^\/api\/plans\/[^/]+\/revise$/.test(path))) {
        const raw = request.cookies[SESSION_COOKIE_NAME], unsigned = raw ? request.unsignCookie(raw) : undefined;
        const identity = unsigned?.valid && unsigned.value && /^[A-Za-z0-9_-]{43}$/.test(unsigned.value) ? `session:${unsigned.value}` : `ip:${request.ip}`;
        // Store only an HMAC, never an IP address or the bearer session identifier.
        const fingerprint = createHmac('sha256', config.cookieSecret).update(identity).digest('hex');
        await quotas.reservePlan(fingerprint);
      }
    } catch (error) {
      if (error instanceof ServiceError) return reply.code(error.statusCode).send({error: error.message, code: error.code});
      throw error;
    }
  });
}
