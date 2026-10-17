import {useEffect, useState} from 'react';
import type {PlaceImage} from '../../shared/types';
import {placeImageHref} from './PlaceMedia';
import './JourneyPhoto.css';

type JourneyPhotoProps = {
  image?: PlaceImage;
  fallbackUrls: readonly string[];
  failedUrls: readonly string[];
  onPhotoError: (url: string) => void;
};
type PhotoFrame = {current?: string; previous?: string};

/** Decode only the requested photo; keep the last image visible until its replacement is ready. */
export function JourneyPhoto({image, fallbackUrls, failedUrls, onPhotoError}: JourneyPhotoProps) {
  const selectedUrl = image && placeImageHref(image.url);
  const showingSelection = !!selectedUrl && !failedUrls.includes(selectedUrl);
  const href = showingSelection ? selectedUrl : fallbackUrls.find(url => !failedUrls.includes(url));
  const [frame, setFrame] = useState<PhotoFrame>({});

  useEffect(() => {
    if (!href) {setFrame({}); return;}
    let cancelled = false;
    const candidate = new Image();
    candidate.decoding = 'async';
    candidate.referrerPolicy = 'no-referrer';
    candidate.fetchPriority = showingSelection ? 'auto' : 'low';
    candidate.onload = async () => {
      try {await candidate.decode();}
      catch {if (!candidate.naturalWidth) {if (!cancelled) onPhotoError(href); return;}}
      if (!cancelled) setFrame(current => current.current === href ? current : {
        current: href,
        previous: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? undefined : current.current,
      });
    };
    candidate.onerror = () => {if (!cancelled) onPhotoError(href);};
    candidate.src = href;
    return () => {cancelled = true; candidate.onload = null; candidate.onerror = null;};
  }, [href, showingSelection, onPhotoError]);

  return <span className="journey-photo" aria-hidden="true">
    {frame.previous && <img className="journey-photo__previous" src={frame.previous} alt="" decoding="async" referrerPolicy="no-referrer" draggable={false} />}
    {frame.current && <img key={frame.current} className="journey-photo__current" src={frame.current} alt="" decoding="async" referrerPolicy="no-referrer" draggable={false}
      onAnimationEnd={event => {if (event.target === event.currentTarget) setFrame(current => current.current === frame.current ? {current: current.current} : current);}} />}
  </span>;
}
