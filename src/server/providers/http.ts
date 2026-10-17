import {setTimeout as pause} from 'node:timers/promises';
import {assertPlanActive, planOperationSignal} from '../services/operation-deadline.js';
import {ServiceError} from '../errors.js';
import {reserveProviderRequest} from '../services/quotas.js';
export {ServiceError, isTerminalProviderFailure} from '../errors.js';

export async function fetchJson(url: string | URL, init: RequestInit, service: string, timeoutMs = 12_000): Promise<unknown> {
  assertPlanActive();
  const deadline = planOperationSignal();
  const signal = deadline ? AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    await reserveProviderRequest(url);
    assertPlanActive();
    signal.throwIfAborted();
    let response = await fetch(url, { ...init, redirect: 'error', signal });
    // Retry one rejected read, never a potentially completed provider mutation.
    if (response.status === 429 && (!init.method || init.method.toUpperCase() === 'GET')) {
      const header = response.headers.get('retry-after');
      const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : undefined;
      const delay = seconds !== undefined ? seconds * 1000 : header && Number.isFinite(Date.parse(header)) ? Math.max(0, Date.parse(header) - Date.now()) : 1000;
      if (delay <= 5000) {
        await response.body?.cancel();
        await pause(Math.max(100, delay), undefined, {signal});
        assertPlanActive();
        await reserveProviderRequest(url);
        assertPlanActive();
        signal.throwIfAborted();
        response = await fetch(url, {...init, redirect: 'error', signal});
      }
    }
    if (!response.ok) {
      if (response.status === 404) throw new ServiceError(`${service} returned no matches.`, 502, 'PROVIDER_NOT_FOUND');
      if (response.status === 429) throw new ServiceError(`${service} is busy. Please try again shortly.`, 503, 'PROVIDER_BUSY');
      throw new ServiceError(`${service} could not complete the request. Please try again.`, 502);
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 1_000_000) throw new ServiceError(`${service} returned an unexpected response.`);
    const body = await response.text();
    if (body.length > 1_000_000) throw new ServiceError(`${service} returned an unexpected response.`);
    return JSON.parse(body) as unknown;
  } catch (error) {
    assertPlanActive();
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(`${service} is unavailable right now. Please try again.`, 502, 'PROVIDER_UNAVAILABLE');
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function cleanText(value: unknown, maxLength = 300): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, maxLength) : '';
}
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

/** Official public websites may use HTTP; provider API and media URLs remain HTTPS-only. */
export function safeWebsiteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
