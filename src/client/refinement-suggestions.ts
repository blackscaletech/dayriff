import type {ChatMessage, Itinerary} from '../shared/types';

type SuggestionPlan = Pick<Itinerary, 'input' | 'stops' | 'totalWalkMinutes'>;

/** Local conversation shortcuts: no provider calls, new facts, or hidden planning constraints. */
export function refinementSuggestions(messages: readonly ChatMessage[], plan?: SuggestionPlan): string[] {
  const requests = messages.filter(message => message.role === 'user').map(message => message.text);
  const asked = requests.join('\n');
  const budgetRequest = [...requests].reverse().find(text => /\b(cheap|cheaper|affordable|budget|expensive|luxury|high[ -]end|fine[ -]dining|michelin)\b/i.test(text));
  const premium = plan?.input.budget === 'high' || Boolean(budgetRequest && /\b(luxury|high[ -]end|fine[ -]dining|michelin)\b/i.test(budgetRequest) && !/\b(cheap|cheaper|affordable)\b/i.test(budgetRequest));
  const has = (category: string) => Boolean(plan?.stops.some(stop => stop.category === category));
  const walkingShare = plan ? plan.totalWalkMinutes / plan.input.durationMinutes : 0;
  const candidates = [
    {label: 'Less walking', score: walkingShare > .35 ? 100 : 55, available: !plan || plan.totalWalkMinutes >= 25, asked: /\b(walk|walking|closer|nearer)\b/i},
    {label: 'More culture', score: has('culture') ? 38 : 76, available: true, asked: /\b(cultur\w*|museums?|galler\w*|art)\b/i},
    {label: 'Add a café', score: has('food') ? 32 : 75, available: true, asked: /\b(caf[eé]s?|coffee|restaurants?|food|dining|lunch|dinner|breakfast)\b/i},
    {label: 'Make it cheaper', score: plan?.stops.some(stop => (stop.costTier ?? 0) > 1) ? 65 : 48, available: !premium && plan?.input.budget !== 'low', asked: /\b(cheap\w*|affordable|budget|free|spend\w*|cost\w*)\b/i},
    {label: 'Local shops', score: has('shop') ? 22 : 42, available: true, asked: /\b(shops?|shopping|bookstores?|records?|boutiques?)\b/i},
    {label: 'Something outdoors', score: has('outdoors') ? 20 : 40, available: true, asked: /\b(outdoors?|parks?|gardens?|fresh air)\b/i},
    {label: 'A slower pace', score: (plan?.stops.length ?? 0) >= 3 ? 60 : 28, available: (plan?.stops.length ?? 2) >= 2, asked: /\b(slow\w*|relax\w*|pace|rush\w*|fewer|less stops)\b/i},
    {label: 'Add another stop', score: 58, available: Boolean(plan && plan.stops.length < 3 && plan.input.durationMinutes >= 180 && walkingShare < .5), asked: /\b(more stops|another stop|add .*stop|at least \d|\d stops|options)\b/i},
    {label: 'Why these places?', score: requests.length ? 52 : 15, available: true, asked: /\b(why|inspir\w*|match\w*|connect\w*)\b/i},
    {label: 'What should I book ahead?', score: premium ? 80 : 14, available: true, asked: /\b(book\w*|reserv\w*|tickets?)\b/i},
    {label: 'Show different options', score: 12, available: true, asked: /\b(different|alternativ\w*|other options|change.*plan|swap|replace)\b/i},
    {label: 'How much time at each stop?', score: 10, available: true, asked: /\b(time at|how long|duration|minutes? at)\b/i},
  ];
  return candidates.filter(candidate => candidate.available && !candidate.asked.test(asked))
    .sort((a, b) => b.score - a.score).slice(0, 3).map(candidate => candidate.label);
}
