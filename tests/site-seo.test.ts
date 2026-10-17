import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createHttpServer} from '../src/server/app.js';
import {registerSecurity} from '../src/server/security.js';
import {registerSeoRoutes} from '../src/server/seo-routes.js';
import {createMemoryStateStore} from '../src/server/storage/index.js';
import {publishedOrigin, renderHomepageHtml, robotsText, sendHomepageHtml, serializeStructuredData, sitemapXml, SITE_DESCRIPTION, SITE_TITLE} from '../src/server/services/site-seo.js';
import type {ServerConfig} from '../src/server/config.js';

const production: ServerConfig = {mode: 'live', production: true, port: 3000, host: '127.0.0.1', appOrigin: 'https://dayriff.example.com',
  cookieSecret: 'seo-tests-only-persistent-cookie-secret-32chars', qlooApiUrl: 'https://hackathon.api.qloo.com', openaiModel: 'test', openaiReasoningEffort: 'medium', maxDailyPlans: 100, maxDailyLookups: 2000};
const template = '<!doctype html><html lang="en"><head><title>Old title</title><meta name="description" content="Old description"><meta name="robots" content="noindex"><meta property="og:title" content="Old OG"><meta name="twitter:card" content="summary"><link rel="canonical" href="https://old.example/"><meta name="theme-color" content="#000"><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/favicon.svg"><script type="application/ld+json">{"old":"not current"}</script></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';
async function appFor(config: ServerConfig) {
  const app = createHttpServer(config);
  await registerSecurity(app, config, false, createMemoryStateStore());
  await registerSeoRoutes(app, {config, template: async () => template});
  app.setNotFoundHandler(async (_request, reply) => sendHomepageHtml(reply, template, config, 404));
  return app;
}

test('homepage HTML gives no-JS crawlers one honest public identity, absolute social image and structured application facts', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => {throw new Error('Homepage identity must not query providers');});
  const app = await appFor(production);
  try {
    const response = await app.inject({url: '/', headers: {host: 'attacker.invalid', 'x-forwarded-host': 'poisoned.invalid', 'user-agent': 'Googlebot'}});
    assert.equal(response.statusCode, 200); assert.match(String(response.headers['content-type']), /text\/html/);
    const html = response.body;
    assert.ok(html.includes(`<title>${SITE_TITLE}</title>`)); assert.ok(html.includes(SITE_DESCRIPTION));
    assert.ok(html.includes('rel="canonical" href="https://dayriff.example.com/"'));
    assert.ok(html.includes('property="og:url" content="https://dayriff.example.com/"'));
    assert.ok(html.includes('property="og:image" content="https://dayriff.example.com/share-dayriff.jpg"'));
    assert.ok(html.includes('property="og:image:width" content="1200"')); assert.ok(html.includes('property="og:image:height" content="630"'));
    assert.ok(html.includes('property="og:image:alt"')); assert.ok(html.includes('name="twitter:image:alt"'));
    assert.ok(html.includes('name="twitter:card" content="summary_large_image"'));
    assert.ok(html.includes('name="theme-color" content="#382341"'));
    assert.ok(html.includes('href="/favicon.svg"')); assert.ok(html.includes('href="/assets/app.css"')); assert.ok(html.includes('src="/assets/app.js"'));
    for (const absent of ['attacker.invalid', 'poisoned.invalid', 'https://old.example/', 'Old title', 'Old description', 'Old OG', 'not current', 'FAQPage', 'aggregateRating', 'award', 'partnership']) assert.ok(!html.includes(absent), absent);
    for (const expression of [/<title>/g, /name="description"/g, /rel="canonical"/g, /property="og:title"/g, /type="application\/ld\+json"/g]) assert.equal((html.match(expression) ?? []).length, 1);
    const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]; assert.ok(json);
    const graph = JSON.parse(json)['@graph'] as {['@type']: string; sameAs?: string[]; operatingSystem?: string; featureList?: string[]}[];
    assert.deepEqual(graph.map(item => item['@type']), ['Person', 'WebSite', 'WebApplication']);
    assert.deepEqual(graph[0]!.sameAs, ['https://x.com/ivanciraj']); assert.equal(graph[2]!.operatingSystem, 'Web'); assert.match(graph[2]!.featureList!.join(' '), /Qloo/);
    const expectedHash = `'sha256-${createHash('sha256').update(json).digest('base64')}'`;
    const csp = String(response.headers['content-security-policy']); assert.ok(csp.includes(expectedHash)); assert.match(csp, /script-src 'self' 'sha256-/); assert.ok(!csp.includes("'unsafe-inline'")); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
    assert.equal(response.headers['set-cookie'], undefined); assert.equal(response.headers['x-robots-tag'], undefined); assert.equal(response.headers['cache-control'], 'no-cache'); assert.equal(network.mock.calls.length, 0);
  } finally {await app.close();}
});

test('preview and sample HTML cannot acquire a guessed canonical URL or get indexed', async () => {
  for (const config of [{...production, production: false}, {...production, mode: 'sample' as const}, {...production, appOrigin: undefined}]) {
    const page = renderHomepageHtml(template, config);
    assert.equal(page.indexable, false); assert.equal(page.scriptHash, undefined);
    assert.ok(page.html.includes('name="robots" content="noindex, nofollow, noarchive"'));
    assert.ok(!page.html.includes('rel="canonical"')); assert.ok(!page.html.includes('property="og:url"')); assert.ok(!page.html.includes('type="application/ld+json"'));
    assert.ok(!page.html.includes('dayriff.example.com')); assert.ok(!page.html.includes('https://old.example/'));
    assert.equal(robotsText(config), 'User-agent: *\nDisallow: /\n'); assert.ok(!sitemapXml(config).includes('<url>'));
  }
  const app = await appFor({...production, production: false});
  try {const response = await app.inject('/'); assert.match(String(response.headers['x-robots-tag']), /noindex/);}
  finally {await app.close();}
});

test('published identity accepts only the configured exact public HTTPS origin and never arbitrary paths or markup', () => {
  assert.equal(publishedOrigin(production), production.appOrigin);
  for (const origin of ['http://dayriff.example.com', 'https://dayriff.example.com/', 'https://dayriff.example.com/path', 'https://dayriff.example.com?query=private', 'https://dayriff.example.com#private', 'https://user:secret@dayriff.example.com', 'https://localhost', 'https://localhost.localhost', 'https://192.168.1.1', 'https://127.0.0.1', 'https://[::1]', 'https://preview.internal', 'https://preview.test', 'https://dayriff.example.com/"/><script>bad()</script>', 'not-a-url']) {
    assert.equal(publishedOrigin({...production, appOrigin: origin}), undefined, origin);
  }
  const text = '</script><script>alert("bad")</script>&\u2028\u2029';
  const serialized = serializeStructuredData({text});
  assert.ok(!serialized.includes('</script>')); assert.ok(!serialized.includes('<')); assert.ok(!serialized.includes('&')); assert.ok(!serialized.includes('\u2028')); assert.ok(!serialized.includes('\u2029'));
  assert.deepEqual(JSON.parse(serialized), {text});
});

test('production robots and sitemap expose only the public homepage, never a saved trip or session', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => {throw new Error('Discovery files must not query providers');});
  const app = await appFor(production);
  try {
    const robots = await app.inject('/robots.txt'); assert.equal(robots.statusCode, 200); assert.match(String(robots.headers['content-type']), /text\/plain/);
    assert.ok(robots.body.includes('Disallow: /api/')); assert.ok(!robots.body.includes('Disallow: /shared/')); assert.ok(robots.body.includes('Sitemap: https://dayriff.example.com/sitemap.xml'));
    const sitemap = await app.inject('/sitemap.xml'); assert.equal(sitemap.statusCode, 200); assert.match(String(sitemap.headers['content-type']), /application\/xml/);
    assert.equal((sitemap.body.match(/<loc>/g) ?? []).length, 1); assert.ok(sitemap.body.includes('<loc>https://dayriff.example.com/</loc>'));
    for (const privateText of ['/shared', '/api', 'session', 'startingPoint', 'chat', 'budget', 'lastmod']) assert.ok(!sitemap.body.includes(privateText), privateText);
    assert.equal(robots.headers['set-cookie'], undefined); assert.equal(sitemap.headers['set-cookie'], undefined); assert.equal(network.mock.calls.length, 0);
  } finally {await app.close();}
});

test('unknown HTML paths are real noindex 404s without a homepage canonical or stale structured data', async () => {
  const app = await appFor(production);
  try {
    const response = await app.inject('/made-up-page?startingPoint=Private%20hotel');
    assert.equal(response.statusCode, 404); assert.match(String(response.headers['x-robots-tag']), /noindex/);
    assert.ok(response.body.includes('<title>Page not found | Dayriff</title>'));
    for (const absent of ['rel="canonical"', 'application/ld+json', 'property="og:url"', 'Private hotel', 'startingPoint']) assert.ok(!response.body.includes(absent), absent);
    const redirected = await app.inject('/index.html'); assert.equal(redirected.statusCode, 301); assert.equal(redirected.headers.location, '/');
  } finally {await app.close();}
});

test('source template contains an honest, readable no-JavaScript fallback without generated SEO filler', async () => {
  const source = await readFile('index.html', 'utf8');
  assert.match(source, /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png(?:\?[^"]*)?"/);
  assert.ok(!source.includes('apple-mobile-web-app-capable'));
  const fallback = source.match(/<noscript data-dayriff-fallback>([\s\S]*?)<\/noscript>/)?.[1]; assert.ok(fallback);
  assert.ok(fallback.includes('<h1>Make a day of the show.</h1>')); assert.ok(fallback.includes('Discover places you’ll love, inspired by who you’re seeing.'));
  assert.ok(fallback.includes('Enable JavaScript to choose an artist and venue and plan your outing.'));
  assert.ok(!source.includes('dayriff.example.com')); assert.ok(!source.includes('application/ld+json')); assert.ok(!source.includes('unsafe-inline'));
});
