import {useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent} from 'react';
import type {ChatMessage, Itinerary} from '../../shared/types';
import {refinementSuggestions} from '../refinement-suggestions';
import type {RevisionStatus} from '../hooks/usePlanner';
import {describeFailure, type ClientFailure} from '../failures';
import {Icon} from './Icon';
import {FailureNotice} from './FailureNotice';
import './Refinement.css';

export function Refinement({messages, pendingMessage, busy, failure, notices, onRevise, onRetry, onEditPlan, plan, active = true}: {
  messages: ChatMessage[]; pendingMessage: string; busy: boolean; failure: ClientFailure | null; notices: string[]; plan?: Itinerary; active?: boolean;
  onRevise: (message: string) => Promise<RevisionStatus>; onRetry: () => Promise<RevisionStatus>; onEditPlan: () => void;
}) {
  const [text, setText] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const followNextUpdate = useRef(false);
  const sending = useRef(false);
  const pendingBaseline = useRef(messages);
  const draftVersion = useRef(0);
  const restoredDraft = useRef<{text: string; version: number; baseline: ChatMessage[]} | null>(null);
  const last = messages.at(-1), beforeLast = messages.at(-2);
  const recordedPending = messages !== pendingBaseline.current && Boolean(pendingMessage) &&
    ((last?.role === 'user' && last.text === pendingMessage) || (beforeLast?.role === 'user' && beforeLast.text === pendingMessage));
  const recordedReply = recordedPending && last?.role === 'assistant';
  const thinking = Boolean(pendingMessage) && !recordedReply;
  const suggestions = useMemo(() => refinementSuggestions(messages, plan), [messages, plan]);
  const failedRequest = failure?.operation === 'revise' ? failure.request : undefined;
  const failurePresentation = failure ? describeFailure(failure) : null;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (active && element && element.clientHeight && (followNextUpdate.current || nearBottom.current)) {
      element.scrollTop = element.scrollHeight;
      nearBottom.current = true;
    }
    followNextUpdate.current = false;
  }, [messages, pendingMessage, failure, active]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (active && element.clientHeight && nearBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [text, active]);

  useEffect(() => {
    const restored = restoredDraft.current;
    if (!restored || failure || messages === restored.baseline) return;
    const user = messages.at(-1)?.role === 'user' ? messages.at(-1) : messages.at(-2);
    if (user?.role === 'user' && user.text === restored.text) {
      if (draftVersion.current === restored.version) setText(current => current.trim() === restored.text ? '' : current);
      restoredDraft.current = null;
    }
  }, [messages, failure]);
  function restoreDraft(message: string, version: number) {
    if (draftVersion.current !== version) return;
    setText(current => {
      if (current) return current;
      restoredDraft.current = {text: message, version, baseline: messages};
      return message;
    });
  }
  function prepare() {sending.current = true; pendingBaseline.current = messages; followNextUpdate.current = true; nearBottom.current = true;}
  async function send(message: string, fromComposer = false) {
    if (!message || busy || sending.current) return;
    const version = draftVersion.current;
    prepare();
    if (fromComposer) setText('');
    try {
      const result = await onRevise(message);
      if (result === 'failed' && fromComposer) restoreDraft(message, version);
    } finally {sending.current = false;}
  }
  async function retry() {
    if (!failure || busy || sending.current) return;
    const request = failedRequest, version = draftVersion.current;
    const retryingDraft = Boolean(request && text.trim() === request);
    prepare();
    if (retryingDraft) setText('');
    try {
      const result = await onRetry();
      if (result === 'failed' && retryingDraft && request) restoreDraft(request, version);
    } finally {sending.current = false;}
  }
  function submit(event: FormEvent<HTMLFormElement>) {event.preventDefault(); void send(text.trim(), true);}
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(text.trim(), true);
    }
  }
  return <section className="refinement" aria-label="Adjust your plan">
    <div ref={viewport} className="refinement__messages" role="log" aria-label="Conversation with Dayriff" aria-live="polite" aria-relevant="additions text" onScroll={event => {
      const element = event.currentTarget;
      if (!active || !element.clientHeight) return;
      nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
    }}>
      <ol className="conversation">
        {messages.length ? messages.map((message, index) => <li key={`${index}-${message.role}`} className={`conversation__message conversation__message--${message.role}`}><span className="conversation__author sr-only">{message.role === 'user' ? 'You' : 'Dayriff'}</span><p>{message.text}</p></li>) : <li className="conversation__message conversation__message--assistant"><span className="conversation__author sr-only">Dayriff</span><p>What would you like to change?</p></li>}
        {pendingMessage && !recordedPending && <li className="conversation__message conversation__message--user"><span className="conversation__author sr-only">You</span><p>{pendingMessage}</p></li>}
        {failedRequest && !pendingMessage && <li className="conversation__message conversation__message--user"><span className="conversation__author sr-only">You</span><p>{failedRequest}</p></li>}
        {thinking && <li className="conversation__message conversation__message--assistant conversation__message--thinking"><span className="conversation__author sr-only">Dayriff</span><p><span className="conversation__dots" aria-hidden="true"><i /><i /><i /></span><span className="sr-only">Thinking about your plan…</span></p></li>}
        {failure && <li className="conversation__message conversation__message--failure"><span className="conversation__author sr-only">Dayriff</span><FailureNotice failure={failure} announce={false} action={failurePresentation?.recovery === 'retry' ? {label: 'Try again', onClick: () => {void retry();}, disabled: busy} : failurePresentation?.recovery === 'editPlan' || failurePresentation?.recovery === 'editStartingPoint' ? {label: 'Review plan details', onClick: onEditPlan, disabled: busy} : undefined} /></li>}
      </ol>
    </div>
    <div className="refinement__composer">
      {notices.length > 0 && <details className="refinement__notes"><summary>Before you go<Icon name="chevron" size={13} /></summary><div>{notices.map((notice, index) => <p key={index}>{notice}</p>)}</div></details>}
      {suggestions.length > 0 && <div className="refinement__suggestions" role="group" aria-label="Suggested messages">{suggestions.map(suggestion => <button key={suggestion} className="button button--glass button--small" type="button" disabled={busy} onClick={() => {void send(suggestion);}}>{suggestion}</button>)}</div>}
      <form className="refinement__form" onSubmit={submit}>
        <label htmlFor="refinement-message" className="sr-only">What would you like to change?</label>
        <textarea ref={input} id="refinement-message" value={text} onChange={event => {draftVersion.current += 1; restoredDraft.current = null; setText(event.target.value);}} onKeyDown={keyDown} maxLength={600} rows={1} enterKeyHint="send" placeholder="Message Dayriff…" />
        <button className="button button--primary refinement__send" type="submit" disabled={busy || !text.trim()} aria-label="Send message">{busy ? <span className="spinner" /> : <Icon name="arrow" size={19} />}</button>
      </form>
    </div>
  </section>;
}
