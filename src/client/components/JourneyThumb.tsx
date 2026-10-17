import {useState} from 'react';
import type {PlaceImage} from '../../shared/types';
import {placeImageHref} from './PlaceMedia';
import {Icon} from './Icon';
import './JourneyThumb.css';
export function JourneyThumb({image, name, number}: {image?: PlaceImage; name: string; number?: number}) {
  const [failed, setFailed] = useState(false), href = image && placeImageHref(image.url);
  return <span className="journey-thumb" aria-hidden="true">{href && !failed ? <img src={href} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Icon name="pin" size={20} />}{number !== undefined && <span className="journey-thumb__number" aria-hidden="true">{number}</span>}<span className="sr-only">{name}</span></span>;
}
