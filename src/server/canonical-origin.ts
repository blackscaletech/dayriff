import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from './config.js';
import {publishedOrigin} from './services/site-seo.js';

/** Keep the optional www mapping on the same browser origin as cookies and API mutations. */
export function registerCanonicalOrigin(app: FastifyInstance, config: ServerConfig): void {
  const origin = publishedOrigin(config);
  if (!origin) return;
  const canonical = new URL(origin);
  if (canonical.port || canonical.hostname.startsWith('www.')) return;
  const alias = `www.${canonical.hostname}`;
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return;
    // Do not use request.hostname: trustProxy may derive it from a supplied forwarded header.
    const authority = request.raw.httpVersionMajor === 2 ? request.raw.headers[':authority'] : request.raw.headers.host;
    if (typeof authority !== 'string' || ![alias, `${alias}:443`].includes(authority.toLowerCase())) return;
    const target = request.raw.url ?? '/';
    const destination = canonicalRedirectUrl(origin, target);
    if (!destination) return reply.code(400).header('Cache-Control', 'no-store').send({error: 'That address is not valid.', code: 'INVALID_URL'});
    if (destination.pathname === '/healthz') return;
    return reply.code(308).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('Location', destination.href).send();
  });
}

/** Parse only an origin-form target; the destination origin always comes from server configuration. */
export function canonicalRedirectUrl(origin: string, target: string): URL | undefined {
  if (!target.startsWith('/') || target.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(target)) return;
  try {
    const destination = new URL(target, origin);
    return destination.origin === origin ? destination : undefined;
  } catch {return;}
}
