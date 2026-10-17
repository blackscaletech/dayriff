import {useEffect, useState} from 'react';
import type {SharedTrip} from '../../shared/sharing';
import {api, RequestError} from '../api';
import {externalHref} from '../format';
import {Brand} from './Brand';
import {Icon} from './Icon';
import {ItineraryHeader} from './ItineraryHeader';
import {JourneyTimeline} from './JourneyTimeline';
import {PlaceDetails} from './PlaceDetails';
import {Sheet} from './Sheet';
import {SiteFooter} from './SiteFooter';
import {HOME_HREF} from '../home-navigation';
import './SharedTripPage.css';

export function SharedTripPage({token}: {token: string}) {
  const [trip, setTrip] = useState<SharedTrip | null>(null), [error, setError] = useState<unknown>(null), [attempt, setAttempt] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {setError(new RequestError('This shared plan is no longer available.', 404, 'SHARE_NOT_FOUND')); return;}
    void api.sharedTrip(token, controller.signal).then(result => {if (!controller.signal.aborted) setTrip(result);}).catch((reason: unknown) => {if (!controller.signal.aborted) setError(reason);});
    return () => controller.abort();
  }, [token, attempt]);
  const expired = error instanceof RequestError && error.status === 404;
  const plan = trip?.itinerary, selected = selectedIndex !== null ? plan?.stops[selectedIndex] : undefined;
  const directions = plan ? externalHref(plan.routeUrl) : undefined;
  return <div className="app-shell"><a className="skip-link" href="#main">Skip to content</a><header className="site-header"><Brand /></header><main id="main" className="main-content">
    {error ? <div className="connection-state shared-trip__failure"><Icon name="pin" size={24} /><h1>{expired ? 'This shared plan is unavailable' : 'This plan couldn’t load'}</h1><p>{expired ? 'The link may have expired or been turned off.' : 'Please try again in a moment.'}</p><div>{!expired && <button className="button button--glass" type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button>}<a className="button button--primary" href={HOME_HREF}>Make your own plan<Icon name="arrow" size={17} /></a></div></div> : !plan ? <div className="connection-state" role="status"><span className="spinner" /><p>Opening shared plan…</p></div> : <div className="itinerary">
      <p className="shared-trip__label">{plan.mode === 'sample' ? 'Shared sample plan' : 'Shared plan'}</p>
      <ItineraryHeader plan={plan} shared />
      <JourneyTimeline plan={plan} readOnly busy={false} pendingStopId={null} changedStopIds={[]} previousNames={{}} stopNotice={null} onOpen={setSelectedIndex} />
      <p className="itinerary__footnote">Walking and arrival times are estimates.</p>
      <nav className="journey-dock" aria-label="Shared plan actions"><a className="button button--glass" href={HOME_HREF}>Make a plan<Icon name="arrow" size={17} /></a>{directions && <a className="button button--primary" href={directions} target="_blank" rel="noopener noreferrer"><Icon name="pin" size={17} />Directions<span className="sr-only"> (opens in a new tab)</span></a>}</nav>
      <Sheet open={Boolean(selected)} title={selected?.name ?? 'Place'} flush immersive onClose={() => setSelectedIndex(null)}>{selected && <PlaceDetails stop={selected} index={selectedIndex!} showDate={plan.input.date} busy={false} readOnly />}</Sheet>
    </div>}
  </main><SiteFooter docked={Boolean(plan) && !error} /></div>;
}
