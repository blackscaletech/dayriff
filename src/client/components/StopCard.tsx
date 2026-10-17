import {useState} from 'react';
import type {Stop} from '../../shared/types';
import {journeyTimeLabel, stopElementId} from '../format';
import {categoryNames} from '../place-presentation';
import {Icon} from './Icon';
import {placeImageHref} from './PlaceMedia';
import './StopCard.css';

type StopCardProps = {
  stop: Stop; showDate: string; index: number; busy: boolean; pending?: boolean; updated?: boolean;
  previousName?: string; notice?: string; onOpen: () => void;
};

export function StopCard({stop, showDate, index, pending = false, updated = false, previousName, notice, onOpen}: StopCardProps) {
  const [loadedImage, setLoadedImage] = useState<string | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const imageHref = stop.image ? placeImageHref(stop.image.url) : undefined;
  const showImage = imageHref && failedImage !== imageHref;
  return <li className="stop">
    <button id={stopElementId(stop.id)} className={`stop-card${updated ? ' stop-card--updated' : ''}${pending ? ' stop-card--pending' : ''}`} type="button" onClick={onOpen} aria-label={`Details for ${stop.name}`}>
      {showImage && loadedImage === imageHref && <img className="stop-card__ambience photo-ambience" src={imageHref} alt="" aria-hidden="true" loading="lazy" decoding="async" referrerPolicy="no-referrer" />}
      <span className={`stop-card__thumbnail stop-card__thumbnail--${stop.category}`}>
        {showImage ? <img className={loadedImage === imageHref ? 'stop-card__image stop-card__image--loaded' : 'stop-card__image'} src={imageHref} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setLoadedImage(imageHref)} onError={() => setFailedImage(imageHref)} /> : <Icon name={stop.category} size={30} />}
        <span className="stop-card__number" aria-hidden="true">{index + 1}</span>
      </span>
      <span className="stop-card__copy">
        <span className="stop-card__eyebrow"><span>{journeyTimeLabel(stop.arrivalDate, stop.arrivalTime, showDate)}</span>{updated && <span className="stop-card__updated" aria-label={previousName ? `Updated, replaces ${previousName}` : 'Updated'}>Updated</span>}</span>
        <span className="stop-card__name">{stop.name}</span>
        <span className="stop-card__meta">{categoryNames[stop.category]} · {stop.durationMinutes} min</span>
        {pending ? <span className="stop-card__activity" role="status"><span className="spinner" />Finding a replacement…</span> : null}
      </span>
      <Icon className="stop-card__chevron" name="chevron" size={16} />
    </button>
    {notice && <p className="stop-card__feedback" role="status">{notice}</p>}
  </li>;
}
