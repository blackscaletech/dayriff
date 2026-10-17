import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from './config.js';
import {publishedOrigin, robotsText, sendHomepageHtml, sitemapXml} from './services/site-seo.js';

/** Only the public home is discoverable; rendering never loads a trip or creates a session. */
export async function registerSeoRoutes(app: FastifyInstance, {config, template}: {config: ServerConfig; template: (url: string) => Promise<string>}) {
  app.get('/', async (request, reply) => sendHomepageHtml(reply, await template(request.url), config));
  app.get('/index.html', async (_request, reply) => reply.header('Cache-Control', 'no-cache').redirect('/', 301));
  app.get('/robots.txt', async (_request, reply) => {
    if (!publishedOrigin(config)) reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(robotsText(config));
  });
  app.get('/sitemap.xml', async (_request, reply) => reply.type('application/xml; charset=utf-8').header('X-Robots-Tag', 'noindex').header('Cache-Control', 'public, max-age=300').send(sitemapXml(config)));
}
