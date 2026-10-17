import type {Stop} from '../../shared/types';
import {externalHref, journeyTimeLabel, telephoneHref, timeLabel} from '../format';
import {categoryNames, placeContext, placeDescription} from '../place-presentation';
import {Icon} from './Icon';
import {PlaceGallery} from './PlaceGallery';
import './PlaceDetails.css';

type PlaceDetailsProps = {
  stop: Stop; showDate: string; index: number; busy: boolean; pending?: boolean; readOnly?: boolean;
  previousName?: string; notice?: string; onSwap?: () => void;
};

export function PlaceDetails({stop, showDate, index, busy, pending = false, readOnly = false, previousName, notice, onSwap}: PlaceDetailsProps) {
  const sourceHref = externalHref(stop.source?.url);
  const directionsHref = externalHref(stop.directionsUrl);
  const phoneHref = telephoneHref(stop.phone);
  const sourceDomain = sourceHref ? new URL(sourceHref).hostname.replace(/^www\./, '') : '';
  const description = placeDescription(stop) || placeContext(stop);
  const localNote = stop.localNote?.trim();
  const listedHours = stop.openingHours?.filter(day => day.closed || day.periods.length > 0) ?? [];
  return <article className="place-details" aria-label={stop.name}>
    <div className="place-details__visual"><PlaceGallery key={stop.id} place={stop} /></div>
    <div className="place-details__content">
      <p className="place-details__eyebrow">Stop {index + 1}<span aria-hidden="true">·</span>{journeyTimeLabel(stop.arrivalDate, stop.arrivalTime, showDate)}–{journeyTimeLabel(stop.departureDate, stop.departureTime, stop.arrivalDate)}</p>
      <h2>{stop.name}</h2>
      <p className="place-details__meta"><span>{categoryNames[stop.category]}</span><span>{stop.durationMinutes} min visit</span>{stop.costTier && <span aria-label={`Price tier ${stop.costTier} of 3`}>{'$'.repeat(stop.costTier)}</span>}</p>
      {!readOnly && previousName && <p className="place-details__change"><Icon name="swap" size={14} /><span>Replaces {previousName}</span></p>}
      {(directionsHref || (!readOnly && onSwap)) && <div className="place-details__actions">
        {directionsHref && <a className="button button--primary button--small" href={directionsHref} target="_blank" rel="noopener noreferrer"><Icon name="pin" size={16} />Directions<span className="sr-only"> to {stop.name} (opens in a new tab)</span></a>}
        {!readOnly && onSwap && <button className="button button--glass button--small" type="button" onClick={onSwap} disabled={busy} aria-busy={pending || undefined}>{pending ? <span className="spinner" /> : <Icon name="swap" size={16} />}{pending ? 'Finding…' : 'Replace stop'}<span className="sr-only"> for {stop.name}</span></button>}
      </div>}
      {!readOnly && pending && <p className="place-details__feedback" role="status">Finding an alternative for this stop…</p>}
      {!readOnly && notice && <p className="place-details__feedback" role="status">{notice}</p>}
      {description && <p className="place-details__description">{description}</p>}
      {localNote && localNote !== description && <section className="place-details__perspective"><h3>Local perspective</h3><p>{localNote}</p></section>}
      {(stop.photoPrompt || listedHours.length > 0 || stop.hoursNote) && <div className="place-details__disclosures">
        {stop.photoPrompt && <details className="place-details__disclosure"><summary><span><Icon name="spark" size={16} />Photo idea</span><Icon name="chevron" size={15} /></summary><div><p>{stop.photoPrompt}</p></div></details>}
        {(listedHours.length > 0 || stop.hoursNote) && <details className="place-details__disclosure"><summary><span><Icon name="clock" size={16} />Listed hours</span><Icon name="chevron" size={15} /></summary><div>{stop.hoursNote && <p>{stop.hoursNote}</p>}{listedHours.length > 0 && listedHours.length < 7 && <p className="place-details__hours-note">Some days aren’t listed.</p>}<dl>{listedHours.map(day => <div key={day.day}><dt>{day.day.charAt(0).toUpperCase() + day.day.slice(1)}</dt><dd>{day.closed ? 'Closed' : day.periods.map((period, periodIndex) => <span key={`${period.opens}-${period.closes}-${periodIndex}`}>{timeLabel(period.opens)}–{timeLabel(period.closes)}</span>)}</dd></div>)}</dl></div></details>}
      </div>}
      {(stop.address || sourceHref || phoneHref) && <div className="place-details__info">
        {stop.address && <div className="place-details__address"><Icon name="pin" size={17} /><p>{stop.address}</p></div>}
        {(sourceHref || phoneHref) && <div className="place-details__links">
          {sourceHref && <a className="button button--glass button--small" href={sourceHref} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15} />Website<span className="sr-only"> and source for {stop.name} (opens in a new tab)</span></a>}
          {phoneHref && <a className="button button--glass button--small" href={phoneHref}><Icon name="phone" size={15} />Call<span className="sr-only"> {stop.phone}: {stop.name}</span></a>}
        </div>}
        {sourceHref && <p className="place-details__source">Source: {sourceDomain}</p>}
      </div>}
    </div>
  </article>;
}
