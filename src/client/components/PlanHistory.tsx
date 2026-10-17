import {useEffect, useState} from 'react';
import type {PlanHistoryEntry} from '../../shared/types';
import {dateLabel, durationLabel, explorationRangeLabel, timeLabel} from '../format';
import {derivePlanningWindow} from '../../shared/planning-window';
import {Icon} from './Icon';
import {JourneyThumb} from './JourneyThumb';
import './PlanHistory.css';

const PAGE_SIZE = 2;
export function PlanHistory({entries, busy, removingId, onRestore, onRemove}: {
  entries: PlanHistoryEntry[]; busy: boolean; removingId: string | null;
  onRestore: (id: string) => Promise<boolean>; onRemove: (id: string) => Promise<boolean>;
}) {
  const [page, setPage] = useState(0), [notice, setNotice] = useState('');
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1), offset = currentPage * PAGE_SIZE;
  const rangeEnd = Math.min(offset + PAGE_SIZE, entries.length);
  useEffect(() => setPage(current => Math.min(current, pageCount - 1)), [pageCount]);
  async function remove(id: string) {if (await onRemove(id)) setNotice('Plan removed.');}
  return <div className="plan-history">
    <p className="sr-only" role="status">{notice}</p>
    {entries.length ? <>
      <div className="plan-history__list" aria-label="Earlier plan versions">{entries.slice(offset, offset + PAGE_SIZE).map(entry => <article className="plan-history__entry" key={entry.id}>
        <p className="plan-history__schedule">{dateLabel(entry.schedule.date)} · Show {timeLabel(entry.schedule.showTime)}<span>Explore {explorationRangeLabel(derivePlanningWindow(entry.schedule))}</span></p>
        <div className="plan-history__meta"><span><Icon name="clock" size={14} />{durationLabel(entry.totalMinutes)}</span><span><Icon name="walk" size={14} />{entry.totalWalkMinutes} min walking</span></div>
        <div className="plan-history__stops">{entry.stops.map(stop => <div key={stop.id}><JourneyThumb image={stop.image} name={stop.name} /><span>{stop.name}</span></div>)}</div>
        <div className="plan-history__actions"><button className="button button--glass button--small" type="button" disabled={busy} onClick={() => {void onRestore(entry.id);}}><Icon name="undo" size={15} />Use this plan</button>
          <button className="button button--glass button--small" type="button" disabled={busy} aria-label={`Remove plan with ${entry.stops.map(stop => stop.name).join(', ')}`} onClick={() => {void remove(entry.id);}}>{removingId === entry.id ? <span className="spinner" /> : <Icon name="close" size={14} />}Remove</button></div>
      </article>)}</div>
      {pageCount > 1 && <nav className="plan-history__pagination" aria-label="Earlier plans pages"><button className="button button--glass button--small" type="button" disabled={currentPage === 0} onClick={() => setPage(current => current - 1)}><Icon name="arrow" size={15} className="plan-history__previous" />Newer</button><span aria-live="polite">{offset + 1}{rangeEnd > offset + 1 ? `–${rangeEnd}` : ''} of {entries.length}</span><button className="button button--glass button--small" type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(current => Math.min(currentPage + 1, pageCount - 1))}>Older<Icon name="arrow" size={15} /></button></nav>}
    </> : <div className="plan-history__empty"><Icon name="history" size={28} /><p>No earlier plans yet.</p></div>}
  </div>;
}
