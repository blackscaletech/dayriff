import {Icon} from './Icon';
import './JourneyDock.css';

export function JourneyDock({routeHref, busy, onAdjust, onShare}: {routeHref?: string; busy: boolean; onAdjust: () => void; onShare: () => void}) {
  return <nav className="journey-dock" aria-label="Journey actions">
    <button className="button button--glass" type="button" onClick={onAdjust}>{busy ? <span className="spinner" /> : <Icon name="chat" size={18} />}Adjust plan</button>
    {routeHref && <a className="button button--primary" href={routeHref} target="_blank" rel="noopener noreferrer"><Icon name="arrow" size={18} />Directions<span className="sr-only"> for your full walking route (opens in a new tab)</span></a>}
    <button className="button button--glass journey-dock__share" type="button" onClick={onShare} disabled={busy} aria-label="Share plan" aria-haspopup="dialog"><Icon name="share" size={20} /></button>
  </nav>;
}
