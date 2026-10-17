import {useEffect, useState} from 'react';
import {toFailure, type ClientFailure} from '../failures';
import {FailureNotice} from './FailureNotice';
import {Icon} from './Icon';
import {Sheet} from './Sheet';
import './TripPrivacy.css';

export function TripPrivacy({open, onClose, onBack, busy, clearing, onClearTrip}: {
  open: boolean; onClose: () => void; onBack: () => void; busy: boolean; clearing: boolean; onClearTrip: () => Promise<void>;
}) {
  const [view, setView] = useState<'privacy' | 'confirm' | 'cleared'>('privacy');
  const [failure, setFailure] = useState<ClientFailure | null>(null);
  useEffect(() => {if (open) {setView('privacy'); setFailure(null);}}, [open]);
  async function clear() {
    if (busy || clearing) return;
    setFailure(null);
    try {await onClearTrip(); setView('cleared');}
    catch (reason: unknown) {setFailure(toFailure(reason, 'clearTrip'));}
  }
  const confirming = view === 'confirm';
  return <Sheet open={open} onClose={onClose} onBack={clearing ? undefined : confirming ? () => {setView('privacy'); setFailure(null);} : onBack} backLabel={confirming ? 'Back to privacy' : 'Back to About'} title={confirming ? 'Clear this trip?' : view === 'cleared' ? 'Trip cleared' : 'Privacy & trip data'} compact className="trip-privacy-sheet">
    <div className="trip-privacy" aria-busy={clearing}>
      {view === 'privacy' ? <>
        <dl className="trip-privacy__details">
          <div><dt>Your saved trip</dt><dd>An anonymous cookie links your plan to this browser. Your plan, chat and earlier versions expire after 30 days without use. No account is needed. Daily usage counters are kept separately to enforce limits.</dd></div>
          <div><dt>Planning services</dt><dd>Qloo receives artist, venue and location searches. OpenAI receives your plan inputs and messages to build and adjust your outing. Photos and directions also connect to their providers.</dd></div>
          <div><dt>Shared plans</dt><dd>Shared links show a copy of your stops and show details for seven days. Your starting point and chat stay private. Clearing your trip also turns off its shared links.</dd></div>
          <div><dt>Your starting point</dt><dd>A precise address is optional. Use a neighborhood or leave it blank to start near the venue.</dd></div>
        </dl>
        <div className="trip-privacy__actions"><button className="button button--glass" type="button" disabled={busy || clearing} onClick={() => setView('confirm')}><Icon name="close" size={16} />Clear trip</button>{busy && <p className="trip-privacy__caption">You can clear your trip when the current update finishes.</p>}</div>
      </> : view === 'confirm' ? <>
        <p className="trip-privacy__lead">Remove your saved plan, chat, earlier versions, shared links and form selections from this browser’s trip?</p>
        <p className="trip-privacy__caption">This cannot be undone. Clearing removes Dayriff’s saved copy; it does not recall requests already sent to planning services.</p>
        {failure && <FailureNotice failure={failure} />}
        <div className="trip-privacy__confirm-actions"><button className="button button--glass" type="button" disabled={clearing} onClick={() => {setView('privacy'); setFailure(null);}}>Keep trip</button><button className="button button--primary" type="button" disabled={busy || clearing} onClick={() => {void clear();}}>{clearing ? <><span className="spinner" />Clearing…</> : failure ? 'Try again' : 'Clear trip'}</button></div>
      </> : <>
        <p className="trip-privacy__lead" role="status">Your saved plan, chat and earlier versions have been removed.</p>
        <button className="button button--primary" type="button" onClick={onClose}>Start fresh<Icon name="arrow" size={17} /></button>
      </>}
    </div>
  </Sheet>;
}
