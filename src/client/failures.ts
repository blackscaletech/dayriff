export type FailureOperation = 'config' | 'session' | 'create' | 'revise' | 'swap' | 'restore' | 'removeHistory' | 'clearTrip' | 'share';
export interface ClientFailure {
  message: string; operation: FailureOperation; code?: string; status?: number;
  request?: string; stopId?: string; versionId?: string;
}
export interface FailurePresentation {
  title: string; location: 'startingPoint' | 'artist' | 'venue' | 'general'; recovery: 'retry' | 'editPlan' | 'editStartingPoint' | 'none';
}
const fallbackMessages: Record<FailureOperation, string> = {
  config: 'Dayriff couldn’t connect. Please try again.',
  session: 'Your previous plan couldn’t be loaded. You can try again or build a new plan.',
  create: 'Your plan couldn’t be built. Please try again.',
  revise: 'That change couldn’t be completed. Your current plan is still here.',
  swap: 'That place couldn’t be replaced. Your current stop is still here.',
  restore: 'That earlier plan couldn’t be restored. Your current plan is still here.',
  removeHistory: 'That earlier plan couldn’t be removed. Please try again.',
  clearTrip: 'Your trip couldn’t be cleared. Your saved plan is still here.',
  share: 'Your link couldn’t be prepared. Please try again.',
};
export function toFailure(reason: unknown, operation: FailureOperation, context: Pick<ClientFailure, 'request' | 'stopId' | 'versionId'> = {}): ClientFailure {
  const source = reason && typeof reason === 'object' ? reason as Record<string, unknown> : {};
  const status = typeof source.status === 'number' && Number.isInteger(source.status) ? source.status : undefined;
  const code = typeof source.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(source.code) ? source.code : undefined;
  const message = code === 'PLAN_CHANGED' ? 'Your saved trip is safe. Reload Dayriff to open its latest version before trying again.' : status !== undefined && reason instanceof Error && reason.message.trim() ? reason.message : status === undefined ? 'The connection was interrupted. Please try again.' : fallbackMessages[operation];
  return {message, operation, ...(status !== undefined ? {status} : {}), ...(code ? {code} : {}), ...context};
}
export function describeFailure(failure: ClientFailure): FailurePresentation {
  const {code = '', status, operation} = failure;
  if (code === 'PLAN_NOT_FOUND') return {title: 'This plan has expired', location: 'general', recovery: 'editPlan'};
  if (code === 'SHARE_LIMIT') return {title: 'Shared links are at capacity', location: 'general', recovery: 'none'};
  if (code === 'PLAN_CHANGED') return {title: 'This trip changed', location: 'general', recovery: 'none'};
  if (['DAILY_LIMIT', 'DAILY_SEARCH_LIMIT', 'SESSION_DAILY_LIMIT', 'PROVIDER_DAILY_LIMIT'].includes(code)) return {title: code === 'DAILY_SEARCH_LIMIT' ? 'Daily search allowance reached' : 'Daily planning allowance reached', location: 'general', recovery: 'none'};
  const retry = code === 'START_UNAVAILABLE' || code === 'PLAN_BUSY' || code === 'PROVIDER_BUSY' || code === 'RATE_LIMITED' || status === undefined || status === 408 || status === 429 || status >= 500;
  if (!retry && (code.startsWith('START_') || code === 'INVALID_START')) {
    return {title: /RANGE|FAR|REACH/.test(code) ? 'Choose a closer starting point' : 'Confirm your starting point', location: 'startingPoint', recovery: 'editStartingPoint'};
  }
  if (!retry && code === 'ARTIST_NOT_FOUND') return {title: 'Choose your artist again', location: 'artist', recovery: 'none'};
  if (!retry && code === 'VENUE_NOT_FOUND') return {title: 'Choose your venue again', location: 'venue', recovery: 'none'};
  const title = code === 'START_UNAVAILABLE' ? 'Starting-point search is unavailable' : code === 'PLAN_BUSY' ? 'Your plan is still updating' : status === 429 ? 'Please wait a moment' : {
    config: 'Unable to connect', session: 'Your previous plan couldn’t load', create: 'Your plan couldn’t load', revise: 'That change couldn’t finish', swap: 'This stop couldn’t be replaced', restore: 'That earlier plan couldn’t load', removeHistory: 'This earlier plan couldn’t be removed', clearTrip: 'Your trip couldn’t be cleared', share: 'Your link couldn’t be prepared',
  }[operation];
  return {title, location: 'general', recovery: retry ? 'retry' : 'none'};
}
