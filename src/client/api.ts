import type {ShareLink, SharedTrip} from '../shared/sharing';
import type { AppConfig, Artist, ChatMessage, Itinerary, PlanHistoryEntry, PlanInput, PlanResponse, RevisionInput, VenueSearchResult } from '../shared/types';

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: options.credentials ?? 'same-origin',
    headers: { ...(options.body !== undefined ? {'Content-Type': 'application/json'} : {}), 'X-Dayriff-Request': '1', ...options.headers },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : 'Something interrupted that request. Please try again.';
    const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' ? data.code : undefined;
    throw new RequestError(message, response.status, code);
  }
  return data as T;
}

export const api = {
  share: (id: string, revision: number, signal?: AbortSignal) => request<ShareLink>(`/api/plans/${encodeURIComponent(id)}/share`, {method: 'POST', body: JSON.stringify({revision}), signal}),
  sharedTrip: async (token: string, signal?: AbortSignal) => {
    const result = await request<SharedTrip | null>(`/api/shared/${encodeURIComponent(token)}`, {signal, credentials: 'omit'});
    if (!result?.itinerary || !Array.isArray(result.itinerary.stops) || !result.itinerary.stops.length || !Number.isFinite(Date.parse(result.expiresAt))) throw new RequestError('This shared plan could not be loaded. Please try again.', 502, 'INVALID_SHARED_RESPONSE');
    return result;
  },
  config: (signal?: AbortSignal) => request<AppConfig>('/api/config', { signal }),
  session: (signal?: AbortSignal) => request<{ itinerary: Itinerary | null; messages: ChatMessage[]; history?: PlanHistoryEntry[] }>('/api/session', { signal }),
  clearSession: async (signal?: AbortSignal) => {
    const result = await request<{cleared: true} | null>('/api/session', {method: 'DELETE', signal});
    if (result?.cleared !== true) throw new RequestError('Your trip could not be cleared. Please try again.', 502, 'INVALID_CLEAR_RESPONSE');
    return result;
  },
  artists: async (query: string, signal?: AbortSignal) => {
    const result = await request<{ artists: Artist[] }>(`/api/artists?q=${encodeURIComponent(query)}`, { signal });
    return result.artists;
  },
  venueSearch: (query: string, cityId?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({q: query});
    if (cityId) params.set('cityId', cityId);
    return request<VenueSearchResult>(`/api/venues?${params}`, {signal});
  },
  plan: (input: PlanInput, signal?: AbortSignal) => request<PlanResponse>('/api/plans', {
    method: 'POST', body: JSON.stringify(input), signal,
  }),
  removeHistory: (id: string, versionId: string, signal?: AbortSignal) => request<{history: PlanHistoryEntry[]}>(`/api/plans/${encodeURIComponent(id)}/history/${encodeURIComponent(versionId)}`, {method: 'DELETE', signal}),
  restore: (id: string, versionId: string, signal?: AbortSignal) => request<PlanResponse>(`/api/plans/${encodeURIComponent(id)}/restore`, {method: 'POST', body: JSON.stringify({versionId}), signal}),
  revise: (id: string, input: RevisionInput, signal?: AbortSignal) => request<PlanResponse>(`/api/plans/${encodeURIComponent(id)}/revise`, {
    method: 'POST', body: JSON.stringify(input), signal,
  }),
};
