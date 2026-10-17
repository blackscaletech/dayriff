import {existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync} from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppMode } from '../shared/types.js';

const envFile = resolve('.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export interface ServerConfig {
  mode: AppMode; port: number; host: string; production: boolean;
  qlooApiKey?: string; qlooApiUrl: string; openaiApiKey?: string;
  openaiModel: string; openaiReasoningEffort: 'low' | 'medium' | 'high'; googleMapsApiKey?: string;
  cookieSecret: string; appOrigin?: string; maxDailyPlans: number; maxDailyLookups: number;
  maxDailyOpenaiRequests?: number; maxDailyQlooRequests?: number; maxDailyRoutesRequests?: number; maxSessionDailyPlans?: number;
  storageBackend?: 'file' | 'firestore' | 'memory'; storageDirectory?: string;
  firestoreProjectId?: string; firestoreDatabaseId?: string; sessionRetentionDays?: number;
}
function numberSetting(value: string | undefined, fallback: number, max: number) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error('Invalid numeric server configuration.');
  return result;
}
function localCookieSecret(directory: string): string {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  chmodSync(directory, 0o700);
  const path = resolve(directory, 'cookie-secret');
  try {writeFileSync(path, randomBytes(32).toString('hex'), {mode: 0o600, flag: 'wx'});} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  chmodSync(path, 0o600);
  const secret = readFileSync(path, 'utf8').trim();
  if (secret.length < 32) throw new Error('The local cookie secret is invalid.');
  return secret;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  const mode = env.APP_MODE || 'sample';
  if (mode !== 'sample' && mode !== 'live') throw new Error('APP_MODE must be sample or live.');
  const openaiReasoningEffort = env.OPENAI_REASONING_EFFORT || 'medium';
  if (!['low', 'medium', 'high'].includes(openaiReasoningEffort)) throw new Error('OPENAI_REASONING_EFFORT must be low, medium, or high.');
  const qlooApiUrl = env.QLOO_API_URL || 'https://hackathon.api.qloo.com';
  const qlooUrl = new URL(qlooApiUrl);
  if (qlooUrl.protocol !== 'https:' || !['hackathon.api.qloo.com', 'api.qloo.com'].includes(qlooUrl.hostname) || qlooUrl.username || qlooUrl.password || qlooUrl.search || qlooUrl.hash) {
    throw new Error('QLOO_API_URL must be an official Qloo HTTPS API origin.');
  }
  if (mode === 'live' && (!env.QLOO_API_KEY || !env.OPENAI_API_KEY)) throw new Error('Live mode requires QLOO_API_KEY and OPENAI_API_KEY.');
  if (production && (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32 || !env.APP_ORIGIN)) throw new Error('Production requires COOKIE_SECRET (32+ characters) and APP_ORIGIN.');
  if (env.APP_ORIGIN) {
    const origin = new URL(env.APP_ORIGIN);
    if (origin.origin !== env.APP_ORIGIN || (production && origin.protocol !== 'https:')) throw new Error('APP_ORIGIN must be an exact HTTPS origin in production.');
  }
  const storageBackend = env.STORAGE_BACKEND || (production ? 'firestore' : 'file');
  if (!['file', 'firestore', 'memory'].includes(storageBackend)) throw new Error('STORAGE_BACKEND must be file, firestore, or memory.');
  if (production && storageBackend !== 'firestore') throw new Error('Production requires shared Firestore storage.');
  const storageDirectory = resolve(env.STORAGE_DIRECTORY || '.private/state');
  return {
    mode, production, port: numberSetting(env.PORT, 3000, 65535), host: env.HOST || '127.0.0.1',
    qlooApiKey: env.QLOO_API_KEY, qlooApiUrl: qlooUrl.origin,
    openaiApiKey: env.OPENAI_API_KEY, openaiModel: env.OPENAI_MODEL || 'gpt-6-luna', openaiReasoningEffort: openaiReasoningEffort as 'low' | 'medium' | 'high',
    googleMapsApiKey: env.GOOGLE_MAPS_API_KEY,
    cookieSecret: env.COOKIE_SECRET || (env === process.env && storageBackend === 'file' ? localCookieSecret(resolve('.private')) : randomBytes(32).toString('hex')),
    storageBackend: storageBackend as 'file' | 'firestore' | 'memory', storageDirectory,
    firestoreProjectId: env.FIRESTORE_PROJECT_ID, firestoreDatabaseId: env.FIRESTORE_DATABASE_ID || '(default)', sessionRetentionDays: 30,
    maxDailyOpenaiRequests: numberSetting(env.MAX_DAILY_OPENAI_REQUESTS, 400, 100000),
    maxDailyQlooRequests: numberSetting(env.MAX_DAILY_QLOO_REQUESTS, 2000, 100000),
    maxDailyRoutesRequests: numberSetting(env.MAX_DAILY_ROUTES_REQUESTS, 300, 100000),
    maxSessionDailyPlans: numberSetting(env.MAX_SESSION_DAILY_PLANS, 30, 1000),
    appOrigin: env.APP_ORIGIN, maxDailyPlans: numberSetting(env.MAX_DAILY_PLANS, 100, 10000), maxDailyLookups: numberSetting(env.MAX_DAILY_LOOKUPS, 2000, 100000),
  };
}
