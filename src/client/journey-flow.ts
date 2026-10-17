export type JourneyStep = 0 | 1 | 2;
export type JourneyReadiness = {artist: boolean; venue: boolean; schedule: boolean};
type JourneyAction = {kind: 'advance'; step: JourneyStep} | {kind: 'incomplete'; step: JourneyStep; field: 'artist' | 'venue' | 'schedule'} | {kind: 'submit'};

export function journeyAction(step: JourneyStep, ready: JourneyReadiness): JourneyAction {
  if (!ready.artist) return {kind: 'incomplete', step: 0, field: 'artist'};
  if (step === 0) return {kind: 'advance', step: 1};
  if (!ready.venue) return {kind: 'incomplete', step: 1, field: 'venue'};
  if (step === 1) return {kind: 'advance', step: 2};
  if (!ready.schedule) return {kind: 'incomplete', step: 2, field: 'schedule'};
  return {kind: 'submit'};
}

export function reachableJourneyStep(requested: JourneyStep, ready: Pick<JourneyReadiness, 'artist' | 'venue'>): JourneyStep {
  if (requested === 0 || !ready.artist) return 0;
  if (requested === 1 || !ready.venue) return 1;
  return 2;
}

export function journeyFailureStep(location: string): JourneyStep | undefined {
  if (location === 'artist') return 0;
  if (location === 'venue' || location === 'startingPoint') return 1;
  return undefined;
}
