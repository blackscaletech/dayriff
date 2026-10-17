import { useState } from 'react';
import type { Category, PlaceImage } from '../../shared/types';
import { externalHref } from '../format';
import { Icon } from './Icon';
import './PlaceMedia.css';

export function placeImageHref(value: string) {
  if (value.startsWith('/api/places/') && !value.startsWith('//')) return value;
  const href = externalHref(value);
  return href?.startsWith('https://') ? href : undefined;
}

export function PlaceMedia({ image, category, name, onAvailabilityChange, loading = 'lazy' }: { image?: PlaceImage; category: Category; name: string; loading?: 'eager' | 'lazy'; onAvailabilityChange?: (available: boolean) => void }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const href = image ? placeImageHref(image.url) : undefined;
  if (!href || failed) return <div className={`place-media place-media--illustration place-media--${category}`} role="img" aria-label={`Route illustration for ${name}`}><svg className="place-media__path" viewBox="0 0 500 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><path d="M-20 160C60 160 50 35 150 55S210 180 310 135 400 30 530 50" /><circle cx="150" cy="55" r="5" /><circle cx="310" cy="135" r="5" /></svg><span className="place-media__symbol"><Icon name={category} size={35} /></span><span className="place-media__illustration-label">Illustration</span></div>;
  return <figure className={`place-media${loaded ? ' place-media--loaded' : ''}`}><img src={href} alt={image?.alt || name} loading={loading} decoding="async" onLoad={() => { setLoaded(true); onAvailabilityChange?.(true); }} onError={() => { setFailed(true); onAvailabilityChange?.(false); }} referrerPolicy="no-referrer" />{image?.attribution?.length ? <figcaption>{image.attribution.map((credit, index) => <span key={`${credit.name}-${index}`}>{externalHref(credit.url) ? <a className="place-media__credit" href={externalHref(credit.url)} target="_blank" rel="noopener noreferrer"><span>Photo: {credit.name}</span><Icon name="external" size={11} /><span className="sr-only"> (opens in a new tab)</span></a> : <span className="place-media__credit place-media__credit--static">Photo: {credit.name}</span>}</span>)}</figcaption> : null}</figure>;
}
