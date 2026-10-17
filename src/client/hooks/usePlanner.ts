import {useEffect, useRef, useState} from 'react';
import type {AppMode, ChatMessage, Itinerary, PlanHistoryEntry, PlanInput, PlanResponse} from '../../shared/types';
import {api, RequestError} from '../api';
import {describeFailure, toFailure, type ClientFailure} from '../failures';
import {CHAT_HISTORY_LIMIT} from '../../shared/chat';
import {completedMutation, snapshotMutation, type MutationSnapshot} from '../retry';
import {tripClearChannel} from '../trip-clear-channel';

export type RevisionStatus = 'changed' | 'answered' | 'failed';
export function usePlanner(mode: AppMode | null) {
  const [plan, setPlan] = useState<Itinerary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<PlanHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ClientFailure | null>(null);
  const [editing, setEditing] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [clearing, setClearing] = useState(false), [formVersion, setFormVersion] = useState(0);
  const [pendingMessage, setPendingMessage] = useState('');
  const [removingVersionId, setRemovingVersionId] = useState<string | null>(null);
  const [pendingStopId, setPendingStopId] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<'swap' | 'tune' | 'restore' | null>(null);
  const [changedStopIds, setChangedStopIds] = useState<string[]>([]);
  const [previousNames, setPreviousNames] = useState<Record<string, string>>({});
  const [updateNotice, setUpdateNotice] = useState('');
  const [stopNotice, setStopNotice] = useState<{id: string; text: string} | null>(null);
  const controller = useRef<AbortController | null>(null), inFlight = useRef(false), lastInput = useRef<PlanInput | null>(null);
  const operationVersion = useRef(0), clearChannel = useRef<ReturnType<typeof tripClearChannel> | null>(null);
  const failedAttempt = useRef<MutationSnapshot | null>(null), recoveryFailure = useRef<ClientFailure | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const channel = tripClearChannel(resetTrip);
    clearChannel.current = channel;
    return () => {channel.close(); clearChannel.current = null;};
  }, []);
  function acceptSession(session: Awaited<ReturnType<typeof api.session>>) {
    if (session.itinerary?.mode === mode) {setPlan(session.itinerary); setMessages(session.messages.slice(-CHAT_HISTORY_LIMIT)); setHistory(session.history ?? []);}
    else {setPlan(null); setMessages([]); setHistory([]);}
  }
  useEffect(() => {
    if (!mode) return;
    const restoringController = new AbortController();
    const restoringVersion = operationVersion.current;
    setRestoring(true);
    void api.session(restoringController.signal).then(session => {
      if (!restoringController.signal.aborted && restoringVersion === operationVersion.current) acceptSession(session);
    }).catch((reason: unknown) => {if (!restoringController.signal.aborted && restoringVersion === operationVersion.current) setFailure(toFailure(reason, 'session'));})
      .finally(() => {if (!restoringController.signal.aborted && restoringVersion === operationVersion.current) setRestoring(false);});
    return () => restoringController.abort();
  }, [mode]);

  function start() {const version = ++operationVersion.current; inFlight.current = true; controller.current = new AbortController(); setBusy(true); setFailure(null); setStopNotice(null); return version;}
  function current(version: number) {return version === operationVersion.current && !controller.current?.signal.aborted;}
  function finish(version: number) {if (version !== operationVersion.current) return; setBusy(false); inFlight.current = false; setPendingMessage(''); setPendingStopId(null); setPendingKind(null);}
  function resetTrip() {
    operationVersion.current += 1;
    controller.current?.abort(); inFlight.current = false;
    setBusy(false); setClearing(false); setRestoring(false); setPlan(null); setMessages([]); setHistory([]); setEditing(false); setFailure(null);
    setPendingMessage(''); setPendingStopId(null); setPendingKind(null); setRemovingVersionId(null);
    setChangedStopIds([]); setPreviousNames({}); setUpdateNotice(''); setStopNotice(null);
    lastInput.current = null; failedAttempt.current = null; recoveryFailure.current = null;
    setFormVersion(version => version + 1);
  }
  function accept(response: PlanResponse, previous: Itinerary, request: string, canonicalMessages?: ChatMessage[]): boolean {
    const changed = response.itinerary.revision !== previous.revision;
    if (changed) {
      const fresh = response.itinerary.stops.filter(stop => !previous.stops.some(old => old.id === stop.id));
      const removed = previous.stops.filter(old => !response.itinerary.stops.some(stop => stop.id === old.id));
      setChangedStopIds(fresh.map(stop => stop.id));
      setPreviousNames(Object.fromEntries(fresh.flatMap(stop => {
        const index = response.itinerary.stops.findIndex(item => item.id === stop.id), old = previous.stops[index];
        return old && removed.some(item => item.id === old.id) ? [[stop.id, old.name]] : fresh.length === 1 && removed.length === 1 ? [[stop.id, removed[0]!.name]] : [];
      })));
      setUpdateNotice(response.message || 'Your plan is updated.');
    }
    setPlan(response.itinerary); setHistory(response.history ?? []);
    if (canonicalMessages) setMessages(canonicalMessages.slice(-CHAT_HISTORY_LIMIT));
    else setMessages(current => [...current, {role: 'user' as const, text: request}, ...(response.message ? [{role: 'assistant' as const, text: response.message}] : [])].slice(-CHAT_HISTORY_LIMIT));
    return changed;
  }
  async function create(input: PlanInput): Promise<boolean> {
    if (inFlight.current) return false;
    lastInput.current = input;
    const operation = start(); setUpdateNotice(''); setChangedStopIds([]); setPreviousNames({});
    try {
      const response = await api.plan(input, controller.current!.signal);
      if (!current(operation)) return false;
      recoveryFailure.current = null; failedAttempt.current = null;
      setPlan(response.itinerary); setHistory(response.history ?? []);
      setMessages(response.message ? [{role: 'assistant', text: response.message}] : []); setEditing(false);
      window.scrollTo({top: 0});
      return true;
    } catch (reason: unknown) {if (current(operation)) setFailure(toFailure(reason, 'create')); return false;}
    finally {finish(operation);}
  }
  async function revise(message: string, replaceStopId?: string, reconcile = false): Promise<RevisionStatus> {
    if (!plan || inFlight.current) return 'failed';
    const operation = start(); setPendingStopId(replaceStopId ?? null); setPendingKind(replaceStopId ? 'swap' : 'tune');
    if (!replaceStopId) setPendingMessage(message);
    try {
      let snapshot = snapshotMutation(plan, messages, message);
      if (reconcile && failedAttempt.current) {
        const session = await api.session(controller.current!.signal);
        if (!current(operation)) return 'failed';
        const outcome = completedMutation(failedAttempt.current, session);
        if (outcome && session.itinerary) {
          const reply = session.messages.at(-1)?.text;
          accept({itinerary: session.itinerary, message: reply, history: session.history}, plan, message, session.messages);
          if (outcome === 'answered' && replaceStopId) setStopNotice({id: replaceStopId, text: reply || 'Your route is unchanged.'});
          failedAttempt.current = null;
          return outcome;
        }
        if (session.itinerary?.id === plan.id) snapshot = snapshotMutation(session.itinerary, session.messages, message);
      }
      failedAttempt.current = snapshot;
      const response = await api.revise(plan.id, {message, ...(replaceStopId ? {replaceStopId} : {})}, controller.current!.signal);
      if (!current(operation)) return 'failed';
      const changed = accept(response, plan, message);
      failedAttempt.current = null;
      if (!changed && replaceStopId) setStopNotice({id: replaceStopId, text: response.message || 'Your route is unchanged.'});
      return changed ? 'changed' : 'answered';
    } catch (reason: unknown) {
      if (current(operation)) setFailure(toFailure(reason, replaceStopId ? 'swap' : 'revise', {request: message, ...(replaceStopId ? {stopId: replaceStopId} : {})}));
      return 'failed';
    } finally {finish(operation);}
  }
  async function restore(versionId: string, reconcile = false): Promise<boolean> {
    if (!plan || inFlight.current) return false;
    const operation = start(); setPendingKind('restore');
    try {
      let snapshot = snapshotMutation(plan, messages, 'Use this earlier plan');
      if (reconcile && failedAttempt.current) {
        const session = await api.session(controller.current!.signal);
        if (!current(operation)) return false;
        if (completedMutation(failedAttempt.current, session) === 'changed' && session.itinerary) {
          accept({itinerary: session.itinerary, message: session.messages.at(-1)?.text, history: session.history}, plan, snapshot.request, session.messages);
          failedAttempt.current = null;
          return true;
        }
        if (session.itinerary?.id === plan.id) snapshot = snapshotMutation(session.itinerary, session.messages, snapshot.request);
      }
      failedAttempt.current = snapshot;
      const response = await api.restore(plan.id, versionId, controller.current!.signal);
      if (!current(operation)) return false;
      accept(response, plan, snapshot.request); failedAttempt.current = null; return true;
    }
    catch (reason: unknown) {if (current(operation)) setFailure(toFailure(reason, 'restore', {versionId})); return false;}
    finally {finish(operation);}
  }
  async function removeHistory(versionId: string): Promise<boolean> {
    if (!plan || inFlight.current) return false;
    const operation = start(); setRemovingVersionId(versionId);
    try {const response = await api.removeHistory(plan.id, versionId, controller.current!.signal); if (!current(operation)) return false; setHistory(response.history); return true;}
    catch (reason: unknown) {if (current(operation)) setFailure(toFailure(reason, 'removeHistory', {versionId})); return false;}
    finally {if (current(operation)) setRemovingVersionId(null); finish(operation);}
  }
  async function clearTrip(): Promise<void> {
    if (inFlight.current || restoring) throw new RequestError('Wait for the current update to finish, then clear your trip.', 409, 'PLAN_BUSY');
    const operation = ++operationVersion.current;
    inFlight.current = true;
    controller.current = new AbortController();
    setClearing(true);
    try {
      await api.clearSession(controller.current.signal);
      if (!current(operation)) return;
      resetTrip(); clearChannel.current?.publish();
      window.scrollTo({top: 0});
    } catch (reason: unknown) {if (current(operation)) throw reason;}
    finally {if (operation === operationVersion.current) {setClearing(false); inFlight.current = false;}}
  }
  async function retry(): Promise<RevisionStatus> {
    if (!failure || inFlight.current || describeFailure(failure).recovery !== 'retry') return 'failed';
    if ((failure.operation === 'revise' || failure.operation === 'swap') && failure.request) return revise(failure.request, failure.stopId, true);
    if (failure.operation === 'removeHistory' && failure.versionId) return await removeHistory(failure.versionId) ? 'answered' : 'failed';
    if (failure.operation === 'restore' && failure.versionId) return await restore(failure.versionId, true) ? 'changed' : 'failed';
    if (failure.operation === 'create' && lastInput.current) return await create(lastInput.current) ? 'changed' : 'failed';
    if (failure.operation === 'session') {
      const operation = start();
      try {const session = await api.session(controller.current!.signal); if (!current(operation)) return 'failed'; acceptSession(session); return 'answered';}
      catch (reason: unknown) {if (current(operation)) setFailure(toFailure(reason, 'session')); return 'failed';}
      finally {finish(operation);}
    }
    return 'failed';
  }
  return {plan, messages, history, busy, clearing, formVersion, removingVersionId, failure, editing, restoring, pendingMessage, pendingStopId, pendingKind, changedStopIds, previousNames, updateNotice, stopNotice, create, revise, restore, removeHistory, clearTrip, retry,
    clearFailure: () => setFailure(null), edit: () => {recoveryFailure.current = failure?.code === 'PLAN_NOT_FOUND' ? failure : null; setFailure(null); setEditing(true); window.scrollTo({top: 0});}, cancelEdit: () => {setFailure(recoveryFailure.current); recoveryFailure.current = null; setEditing(false);}};
}
