import {useEffect, useRef, useState} from 'react';
import type {ChatMessage, Itinerary, PlanHistoryEntry} from '../../shared/types';
import type {RevisionStatus} from '../hooks/usePlanner';
import {describeFailure, type ClientFailure} from '../failures';
import {externalHref} from '../format';
import {Icon} from './Icon';
import {ItineraryHeader} from './ItineraryHeader';
import {SharePlan} from './SharePlan';
import {JourneyTimeline} from './JourneyTimeline';
import {JourneyDock} from './JourneyDock';
import {PlaceDetails} from './PlaceDetails';
import {Refinement} from './Refinement';
import {Sheet} from './Sheet';
import {PlanHistory} from './PlanHistory';
import {FailureNotice} from './FailureNotice';
import './ItineraryView.css';

type Panel = {kind: 'adjust' | 'history'} | {kind: 'place'; id: string} | null;
export function ItineraryView({plan, messages, history, pendingMessage, pendingStopId, pendingKind, changedStopIds, previousNames, updateNotice, stopNotice, busy, failure, onEdit, onSwap, onRevise, onRestore, onRetry, onRemoveHistory, removingVersionId}: {
  plan: Itinerary; messages: ChatMessage[]; history: PlanHistoryEntry[]; removingVersionId: string | null; pendingMessage: string; pendingStopId: string | null; pendingKind: 'swap' | 'tune' | 'restore' | null;
  changedStopIds: string[]; previousNames: Record<string,string>; updateNotice: string; stopNotice: {id: string; text: string} | null; busy: boolean; failure: ClientFailure | null;
  onEdit: () => void; onSwap: (id: string, name: string) => void; onRevise: (message: string) => Promise<RevisionStatus>; onRestore: (id: string) => Promise<boolean>; onRetry: () => Promise<RevisionStatus>; onRemoveHistory: (id: string) => Promise<boolean>;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {heading.current?.focus({preventScroll: true});}, [plan.id]);
  const routeHref = externalHref(plan.routeUrl);
  const selectedIndex = panel?.kind === 'place' ? plan.stops.findIndex(stop => stop.id === panel.id) : -1;
  const selected = plan.stops[selectedIndex];
  useEffect(() => {if (panel?.kind === 'place' && !selected) setPanel(null);}, [panel, selected]);
  const title = panel?.kind === 'place' ? selected?.name ?? 'Place' : panel?.kind === 'history' ? 'Earlier plans' : 'Adjust your plan';

  async function restore(id: string) {const source = panel; const ok = await onRestore(id); if (ok) setPanel(current => current === source && source?.kind === 'history' ? {kind: 'adjust'} : current); return ok;}
  function editDetails() {setPanel(null); onEdit();}
  async function retry() {
    const source = panel, operation = failure?.operation;
    const result = await onRetry();
    if (result !== 'failed' && operation === 'restore') setPanel(current => current === source && source?.kind === 'history' ? {kind: 'adjust'} : current);
    return result;
  }
  const presentation = failure ? describeFailure(failure) : null;
  const recoveryAction = presentation?.recovery === 'retry' ? {label: 'Try again', onClick: () => {void retry();}, disabled: busy} : presentation?.recovery === 'editPlan' || presentation?.recovery === 'editStartingPoint' ? {label: 'Review plan details', onClick: editDetails, disabled: busy} : undefined;
  return <div className="itinerary">
    <ItineraryHeader plan={plan} headingRef={heading} busy={busy} onShare={() => setSharing(true)} />
    <SharePlan key={`${plan.id}-${plan.revision}`} plan={plan} open={sharing} onClose={() => setSharing(false)} />
    {!busy && updateNotice && !stopNotice && <div className="journey-feedback" role="status"><span><span className="journey-feedback__check" aria-hidden="true">✓</span>Plan updated</span>{history[0] && <button className="button button--glass button--small" type="button" onClick={() => {void restore(history[0].id);}}><Icon name="undo" size={15} />Undo</button>}</div>}
    {failure && !panel && <div className="itinerary__failure"><FailureNotice failure={failure} action={recoveryAction} /></div>}
    <JourneyTimeline plan={plan} busy={busy} pendingStopId={pendingStopId} changedStopIds={changedStopIds} previousNames={previousNames} stopNotice={stopNotice} onOpen={index => setPanel({kind: 'place', id: plan.stops[index]!.id})} />
    <p className="itinerary__footnote">Walking and arrival times are estimates.</p>
    <JourneyDock routeHref={routeHref} busy={busy} onAdjust={() => setPanel({kind: 'adjust'})} onShare={() => setSharing(true)} />
    <Sheet open={panel !== null} title={title} flush={panel?.kind === 'place'} immersive={panel?.kind === 'place'} conversation={panel?.kind === 'adjust'} onClose={() => setPanel(null)}
      onBack={panel?.kind === 'history' ? () => setPanel({kind: 'adjust'}) : undefined}
      backLabel="Back to chat">
      {failure && panel && panel.kind !== 'adjust' && <div className={`itinerary__panel-failure${panel.kind === 'place' ? ' itinerary__panel-failure--place' : ''}`}><FailureNotice failure={failure} action={recoveryAction} /></div>}
      {selected && panel?.kind === 'place' && <PlaceDetails key={selected.id} stop={selected} showDate={plan.input.date} index={selectedIndex} busy={busy} pending={pendingStopId === selected.id} previousName={previousNames[selected.id]} notice={stopNotice?.id === selected.id ? stopNotice.text : undefined} onSwap={() => {setPanel(null); onSwap(selected.id, selected.name);}} />}
      <div className="adjust-panel" hidden={panel?.kind !== 'adjust'}>
        <div className="chat-plan-actions" role="group" aria-label="Plan actions">
          <button className="chat-plan-actions__button" type="button" onClick={editDetails} disabled={busy}><Icon name="edit" size={15} />Plan details</button>
          <button className="chat-plan-actions__button" type="button" onClick={() => setPanel({kind: 'history'})}><Icon name="history" size={15} />Earlier plans{history.length > 0 && <span className="chat-plan-actions__count" aria-hidden="true">{history.length}</span>}</button>
        </div>
        <button className="chat-plan-context" type="button" onClick={() => setPanel(null)} aria-label="View current plan"><span aria-live="polite"><strong>{plan.stops.length} {plan.stops.length === 1 ? 'stop' : 'stops'}</strong><span>· {plan.totalWalkMinutes} min walking</span>{busy && <span className="spinner" role="status" aria-label="Request in progress" />}</span><span>View plan<Icon name="arrow" size={15} /></span></button>
        <div className="adjust-panel__conversation"><Refinement key={plan.id} plan={plan} active={panel?.kind === 'adjust'} messages={messages} pendingMessage={pendingMessage} busy={busy} failure={failure} notices={plan.notices} onRevise={onRevise} onRetry={retry} onEditPlan={editDetails} /></div>
      </div>
      {panel?.kind === 'history' && <><PlanHistory entries={history} busy={busy} removingId={removingVersionId} onRemove={onRemoveHistory} onRestore={restore} /></>}
    </Sheet>
  </div>;
}
