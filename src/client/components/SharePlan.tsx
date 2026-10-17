import {useEffect, useState} from 'react';
import type {Itinerary} from '../../shared/types';
import type {ShareLink} from '../../shared/sharing';
import {api} from '../api';
import {describeFailure, toFailure, type ClientFailure} from '../failures';
import {copyTripLink, nativeShareAvailable, shareTrip, tripShareUrl} from '../sharing';
import {Icon} from './Icon';
import {Sheet} from './Sheet';
import {JourneyThumb} from './JourneyThumb';
import {FailureNotice} from './FailureNotice';
import './SharePlan.css';

export function SharePlan({plan, open, onClose}: {plan: Itinerary; open: boolean; onClose: () => void}) {
  const [link, setLink] = useState<ShareLink | null>(null), [failure, setFailure] = useState<ClientFailure | null>(null);
  const [attempt, setAttempt] = useState(0), [working, setWorking] = useState(false), [nativeUnavailable, setNativeUnavailable] = useState(false);
  const [copied, setCopied] = useState(false), [manualCopy, setManualCopy] = useState(false);
  useEffect(() => {
    if (!open || link) return;
    const controller = new AbortController(); setFailure(null);
    void api.share(plan.id, plan.revision, controller.signal).then(result => {
      tripShareUrl(result, window.location.origin);
      if (!controller.signal.aborted) setLink(result);
    }).catch((reason: unknown) => {if (!controller.signal.aborted) setFailure(toFailure(reason, 'share'));});
    return () => controller.abort();
  }, [open, plan.id, plan.revision, link, attempt]);
  const url = link ? tripShareUrl(link, window.location.origin) : '';
  const data = {title: `${plan.venue.city} with ${plan.input.artist.name} · Dayriff`, text: `${plan.input.artist.name} at ${plan.venue.name}`, url};
  const native = !nativeUnavailable && nativeShareAvailable(navigator, data);
  async function copy() {
    setWorking(true);
    const success = await copyTripLink(navigator, url);
    setCopied(success); setManualCopy(!success); setWorking(false);
  }
  async function share() {
    if (!url || working) return;
    setWorking(true);
    // Link is already prepared, so the native call runs directly on this tap.
    const result = await shareTrip(navigator, data);
    if (result === 'unavailable') setNativeUnavailable(true);
    setWorking(false);
  }
  return <Sheet open={open} onClose={onClose} title="Share plan" compact className="share-plan-sheet">
    <div className="share-plan">
      <div className="share-plan__preview"><div className="share-plan__photos" aria-hidden="true">{plan.stops.slice(0, 3).map(stop => <div key={stop.id}><JourneyThumb image={stop.image} name={stop.name} /></div>)}</div><div><strong>{plan.venue.city}</strong><span>{plan.input.artist.name} · {plan.venue.name}</span></div></div>
      <p className="share-plan__description">Shares this version of your stops and show details. Your starting point and chat stay private.</p>
      <div className="share-plan__delivery">{failure ? <FailureNotice failure={failure} action={describeFailure(failure).recovery === 'retry' ? {label: 'Try again', onClick: () => setAttempt(value => value + 1)} : undefined} /> : !link ? <p className="share-plan__status" role="status"><span className="spinner" />Preparing link…</p> : <>
        <div className="share-plan__actions"><button className="button button--primary" type="button" disabled={working} onClick={() => {void (native ? share() : copy());}}><Icon name={native ? 'share' : copied ? 'spark' : 'copy'} size={18} />{native ? 'Share plan' : copied ? 'Link copied' : 'Copy link'}</button>{native && <button className="button button--glass" type="button" disabled={working} onClick={() => {void copy();}}><Icon name="copy" size={17} />{copied ? 'Link copied' : 'Copy link'}</button>}</div>
        <p className="share-plan__caption">Anyone with the link can view this copy until {new Intl.DateTimeFormat('en', {month: 'short', day: 'numeric'}).format(new Date(link.expiresAt))}.</p>
        {copied && <span className="sr-only" role="status">Link copied to clipboard.</span>}
        {manualCopy && <label className="share-plan__manual">Select and copy your link<input readOnly value={url} onFocus={event => event.currentTarget.select()} /></label>}
      </>}</div>
    </div>
  </Sheet>;
}
