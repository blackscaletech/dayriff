import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type {ServerConfig} from '../src/server/config.js';
import {createSessions} from '../src/server/sessions.js';

const config: ServerConfig = {mode: 'sample', port: 3000, host: '127.0.0.1', production: true,
  qlooApiUrl: 'https://hackathon.api.qloo.com', openaiModel: 'test', openaiReasoningEffort: 'medium',
  cookieSecret: 'test-only-session-cookie-signing-secret', maxDailyPlans: 10, maxDailyLookups: 10};
async function sessionApp() {
  const app = Fastify();
  await app.register(cookie, {secret: config.cookieSecret});
  const getSession = createSessions(config);
  app.post('/remember', async (request, reply) => {
    await getSession.mutate(request, reply, async state => {state.messages.push({role: 'assistant', text: 'Saved outing'});});
    return {ok: true};
  });
  app.get('/session', async (request, reply) => ({messages: (await getSession(request, reply)).messages}));
  return app;
}
function sessionCookie(header: string | string[] | undefined): string {
  assert.equal(typeof header, 'string');
  const value = header as string;
  assert.match(value, /Max-Age=2592000/);
  assert.match(value, /Path=\//);
  assert.match(value, /HttpOnly/);
  assert.match(value, /Secure/);
  assert.match(value, /SameSite=Strict/);
  return value.split(';')[0]!;
}

test('active sessions renew the signed browser cookie and expire only after inactivity', async t => {
  let now = Date.UTC(2026, 9, 16, 12);
  t.mock.method(Date, 'now', () => now);
  const app = await sessionApp();
  try {
    const created = await app.inject({method: 'POST', url: '/remember'});
    const initialCookie = sessionCookie(created.headers['set-cookie']);
    now += 25 * 24 * 60 * 60_000;
    const renewed = await app.inject({url: '/session', headers: {cookie: initialCookie}});
    assert.deepEqual(renewed.json().messages, [{role: 'assistant', text: 'Saved outing'}]);
    const renewedCookie = sessionCookie(renewed.headers['set-cookie']);
    assert.equal(renewedCookie, initialCookie, 'Activity extends expiry without replacing the trusted session identity');
    now += 10 * 24 * 60 * 60_000;
    const stillActive = await app.inject({url: '/session', headers: {cookie: renewedCookie}});
    assert.deepEqual(stillActive.json().messages, [{role: 'assistant', text: 'Saved outing'}], 'An active session survives longer than 30 days after creation');
    const activeCookie = sessionCookie(stillActive.headers['set-cookie']);
    now += 31 * 24 * 60 * 60_000;
    const expired = await app.inject({url: '/session', headers: {cookie: activeCookie}});
    assert.deepEqual(expired.json().messages, []);
    assert.notEqual(sessionCookie(expired.headers['set-cookie']), initialCookie, '30 days without activity creates a fresh session');
  } finally {await app.close();}
});

test('a forged cookie cannot renew or read an existing session', async () => {
  const app = await sessionApp();
  try {
    const created = await app.inject({method: 'POST', url: '/remember'});
    const trustedCookie = sessionCookie(created.headers['set-cookie']);
    const forged = await app.inject({url: '/session', headers: {cookie: 'dayriff_session=forged-session'}});
    assert.deepEqual(forged.json().messages, []);
    assert.notEqual(sessionCookie(forged.headers['set-cookie']), trustedCookie);
    const original = await app.inject({url: '/session', headers: {cookie: trustedCookie}});
    assert.deepEqual(original.json().messages, [{role: 'assistant', text: 'Saved outing'}]);
  } finally {await app.close();}
});
