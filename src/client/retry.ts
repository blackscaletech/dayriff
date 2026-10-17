import type {ChatMessage, Itinerary} from '../shared/types';

export interface MutationSnapshot {planId: string; revision: number; request: string; messages: ChatMessage[]}
export function snapshotMutation(plan: Itinerary, messages: ChatMessage[], request: string): MutationSnapshot {
  return {planId: plan.id, revision: plan.revision, request, messages: [...messages]};
}
function equalMessage(left: ChatMessage, right: ChatMessage): boolean {return left.role === right.role && left.text === right.text;}
function hasNewReply(before: ChatMessage[], after: ChatMessage[]): boolean {
  if (!before.length) return after.length >= 2;
  if (before.length === after.length && before.every((message, index) => equalMessage(message, after[index]!))) return false;
  for (let dropped = 0; dropped < before.length; dropped += 1) {
    const retained = before.length - dropped;
    if (after.length < retained + 2) continue;
    if (before.slice(dropped).every((message, index) => equalMessage(message, after[index]!))) return true;
  }
  return false;
}
export function completedMutation(snapshot: MutationSnapshot, session: {itinerary: Itinerary | null; messages: ChatMessage[]}): 'changed' | 'answered' | null {
  const current = session.itinerary, user = session.messages.at(-2), reply = session.messages.at(-1);
  if (!current || current.id !== snapshot.planId || current.revision < snapshot.revision || user?.role !== 'user' || user.text !== snapshot.request || reply?.role !== 'assistant') return null;
  if (current.revision > snapshot.revision) return 'changed';
  return hasNewReply(snapshot.messages, session.messages) ? 'answered' : null;
}
