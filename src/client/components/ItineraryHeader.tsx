import type {Ref} from 'react';
import type {Itinerary} from '../../shared/types';
import {dateLabel, timeLabel} from '../format';
import {Icon} from './Icon';
import './ItineraryView.css';

export function ItineraryHeader({plan, headingRef, onShare, busy = false, shared = false}: {
  plan: Itinerary; headingRef?: Ref<HTMLHeadingElement>; onShare?: () => void; busy?: boolean; shared?: boolean;
}) {
  return <>
    <header className={`itinerary__heading${onShare ? ' itinerary__heading--actions' : ''}`}>
      <p className="itinerary__date">{dateLabel(plan.input.date)}<span aria-hidden="true">·</span>Show {timeLabel(plan.input.showTime)}</p>
      {onShare && <button className="icon-control itinerary__share" type="button" onClick={onShare} disabled={busy} aria-label="Share plan" aria-haspopup="dialog"><Icon name="share" size={20} /></button>}
      <h1 ref={headingRef} tabIndex={-1}>{shared ? '' : 'Your '}{plan.venue.city} plan</h1>
      <p className="itinerary__inspiration"><Icon name="music" size={14} /><span>Inspired by <strong>{plan.input.artist.name}</strong></span></p>
    </header>
    <p className="itinerary__summary"><span>{plan.stops.length} {plan.stops.length === 1 ? 'stop' : 'stops'}</span><span><Icon name="walk" size={14} />{plan.totalWalkMinutes} min walking</span></p>
  </>;
}
