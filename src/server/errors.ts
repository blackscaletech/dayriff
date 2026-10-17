/** Public errors never contain upstream URLs, request bodies, credentials, or response bodies. */
export class ServiceError extends Error {
  constructor(message: string, public statusCode = 502, public code = 'PROVIDER_ERROR') { super(message); }
}

const terminalCodes = new Set(['DAILY_LIMIT', 'DAILY_SEARCH_LIMIT', 'SESSION_DAILY_LIMIT', 'PROVIDER_DAILY_LIMIT', 'QUOTA_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'PLAN_TIMEOUT']);
/** Global budgets and operation cancellation must not become another paid fallback attempt. */
export function isTerminalProviderFailure(error: unknown): boolean {return error instanceof ServiceError && (terminalCodes.has(error.code) || error.code.endsWith('DAILY_LIMIT'));}
