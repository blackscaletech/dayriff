import {Fragment} from 'react';
import type {Itinerary} from '../../shared/types';
import {journeyTimeLabel, timeLabel} from '../format';
import {derivePlanningWindow} from '../../shared/planning-window';
import {Icon} from './Icon';
import {StopCard} from './StopCard';
import './JourneyTimeline.css';

export function JourneyTimeline({plan, busy, pendingStopId, changedStopIds, previousNames, stopNotice, onOpen, readOnly = false}: {
  plan: Itinerary; busy: boolean; readOnly?: boolean; pendingStopId: string | null; changedStopIds: string[];
  previousNames: Record<string, string>; stopNotice: {id: string; text: string} | null; onOpen: (index: number) => void;
}) {
  const start = plan.startingLocation, window = readOnly ? undefined : derivePlanningWindow(plan.input);
  const finalWalk = Math.max(0, plan.totalWalkMinutes - plan.stops.reduce((total, stop) => total + stop.walkMinutes, 0));
  return <ol className="journey-timeline" aria-label="Your journey to the concert">
    {window && <li className="journey-timeline__endpoint"><span className="journey-timeline__marker"><Icon name="pin" size={16} /></span><div><span className="journey-timeline__eyebrow">{journeyTimeLabel(window.startDate, window.startTime, window.showDate)} · Start{start?.approximate ? ' around' : ' at'}</span><h2>{start?.name || plan.venue.name}</h2></div></li>}
    {plan.stops.map((stop, index) => <Fragment key={stop.id}>
      {(!readOnly || index > 0) && <li className="journey-timeline__walk"><Icon name="walk" size={13} /><span>{stop.walkMinutes} min walk</span></li>}
      <StopCard stop={stop} showDate={plan.input.date} index={index} busy={busy} pending={pendingStopId === stop.id} updated={changedStopIds.includes(stop.id)} previousName={previousNames[stop.id]} notice={stopNotice?.id === stop.id ? stopNotice.text : undefined} onOpen={() => onOpen(index)} />
    </Fragment>)}
    <li className="journey-timeline__walk"><Icon name="walk" size={13} /><span>{finalWalk} min walk to the concert</span></li>
    <li className="journey-timeline__endpoint journey-timeline__endpoint--finish"><span className="journey-timeline__marker"><Icon name="music" size={16} /></span><div><span className="journey-timeline__eyebrow">{journeyTimeLabel(plan.estimatedArrivalDate, plan.estimatedArrival, plan.input.date)} · Estimated arrival</span><h2>{plan.venue.name}</h2><p>{plan.input.artist.name} · Show {timeLabel(plan.input.showTime)}</p></div></li>
  </ol>;
}
