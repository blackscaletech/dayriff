import {useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent} from 'react';
import type {Place} from '../../shared/types';
import {placeImages} from '../../shared/place-images';
import {Icon} from './Icon';
import {PlaceMedia} from './PlaceMedia';
import './PlaceGallery.css';

type PhotoFrame = {selected?: string; lastLoaded?: string; retained?: string; requested: Set<string>; loaded: Set<string>; failed: Set<string>};
const PHOTO_LOAD_TIMEOUT_MS = 8_000;
function selectPhoto(current: PhotoFrame, url?: string): PhotoFrame {
  if (current.selected === url && (!url || current.requested.has(url))) return current;
  const ready = !!url && current.loaded.has(url);
  return {...current, selected: url, retained: ready ? undefined : current.lastLoaded,
    lastLoaded: ready ? url : current.lastLoaded, requested: url ? new Set([...current.requested, url]) : current.requested};
}

export function PlaceGallery({place}: {place: Place}) {
  const sourceImages = placeImages(place);
  const [frame, setFrame] = useState<PhotoFrame>(() => ({selected: sourceImages[0]?.url,
    requested: new Set(sourceImages[0] ? [sourceImages[0].url] : []), loaded: new Set(), failed: new Set()}));
  const images = sourceImages.filter(image => !frame.failed.has(image.url));
  const active = Math.max(0, images.findIndex(image => image.url === frame.selected));
  const selected = images[active]?.url;
  const pending = !!selected && !frame.loaded.has(selected);
  const retained = sourceImages.find(image => image.url === (frame.retained ?? frame.lastLoaded) && frame.loaded.has(image.url) && !frame.failed.has(image.url));
  const track = useRef<HTMLDivElement>(null);
  const id = useId();
  const imageSet = images.map(image => image.url).join('\n');

  const availability = (url: string, available: boolean) => setFrame(current => {
    if (current.failed.has(url) || (available && current.loaded.has(url))) return current;
    if (available) return {...current, loaded: new Set([...current.loaded, url]), lastLoaded: current.selected === url || !current.lastLoaded ? url : current.lastLoaded};
    const failed = new Set([...current.failed, url]);
    const remaining = sourceImages.filter(image => !failed.has(image.url));
    const lastLoaded = current.lastLoaded && !failed.has(current.lastLoaded) ? current.lastLoaded : undefined;
    const next = remaining.some(image => image.url === current.selected) ? current.selected
      : remaining.find(image => image.url === lastLoaded)?.url ?? remaining[0]?.url;
    return selectPhoto({...current, selected: undefined, failed, lastLoaded, retained: undefined}, next);
  });

  // Removing an unavailable slide must not leave the scroll position on an empty slot.
  useLayoutEffect(() => {const element = track.current; element?.scrollTo({left: active * element.clientWidth, behavior: 'instant'});}, [imageSet]);
  useEffect(() => {
    if (!selected || !pending) return;
    const timer = window.setTimeout(() => availability(selected, false), PHOTO_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [selected, pending]);
  useEffect(() => {
    if (!frame.retained || pending) return;
    const timer = window.setTimeout(() => setFrame(current => current.selected === selected ? {...current, retained: undefined} : current),
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450);
    return () => window.clearTimeout(timer);
  }, [selected, pending, frame.retained]);

  if (!images.length) return <PlaceMedia category={place.category} name={place.name} />;
  const reveal = (index: number) => setFrame(current => selectPhoto(current, images[index]?.url));
  const goTo = (index: number) => {
    const next = Math.max(0, Math.min(images.length - 1, index)), url = images[next]!.url;
    setFrame(current => current.requested.has(url) ? current : {...current, requested: new Set([...current.requested, url])});
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    track.current?.scrollTo({left: next * track.current.clientWidth, behavior: reduced ? 'instant' : 'smooth'});
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const next = event.key === 'ArrowRight' ? active + 1 : event.key === 'ArrowLeft' ? active - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? images.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault(); goTo(next);
  };
  return <section className={`place-gallery${pending ? ' place-gallery--loading' : ''}`} aria-label={`Photos of ${place.name}`} aria-roledescription={images.length > 1 ? 'carousel' : undefined}>
    {retained && (images.length > 1 || pending || frame.retained) && <div className="place-gallery__retained" aria-hidden="true" inert><PlaceMedia key={retained.url} image={retained} category={place.category} name={place.name} loading="eager" /></div>}
    <div className="place-gallery__track" id={id} ref={track} tabIndex={images.length > 1 ? 0 : undefined} onKeyDown={onKeyDown}
      onScroll={() => {const element = track.current; if (element?.clientWidth) reveal(Math.max(0, Math.min(images.length - 1, Math.round(element.scrollLeft / element.clientWidth))));}}>
      {images.map((image, index) => <div className={`place-gallery__slide${frame.loaded.has(image.url) ? ' place-gallery__slide--loaded' : ''}`} key={image.url} role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${images.length}`} inert={index !== active}>
        {frame.requested.has(image.url) || index === active ? <PlaceMedia image={image} category={place.category} name={place.name} loading="eager" onAvailabilityChange={available => availability(image.url, available)} /> : <div className="place-gallery__placeholder" aria-hidden="true" />}
      </div>)}
    </div>
    {images.length > 1 && <>
      <span className="place-gallery__count" aria-live="polite" aria-atomic="true"><span className="sr-only">Photo </span>{active + 1}<span aria-hidden="true"> / </span><span className="sr-only"> of </span>{images.length}{pending && <span className="spinner" aria-hidden="true" />}<span className="sr-only">{pending ? ', loading' : ''}</span></span>
      <div className="place-gallery__controls">
        <button className="icon-control place-gallery__previous" type="button" aria-label="Previous photo" aria-controls={id} disabled={active === 0} onClick={() => goTo(active - 1)}><Icon name="chevron" size={19} /></button>
        <button className="icon-control place-gallery__next" type="button" aria-label="Next photo" aria-controls={id} disabled={active === images.length - 1} onClick={() => goTo(active + 1)}><Icon name="chevron" size={19} /></button>
      </div>
    </>}
  </section>;
}
