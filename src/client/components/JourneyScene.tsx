import {useCallback, useState} from 'react';
import type {PlaceImage} from '../../shared/types';
import { Icon } from './Icon';
import {JourneyPhoto} from './JourneyPhoto';
import { homepagePhotos } from './homepage-photos';
import './JourneyScene.css';

const musicPhotos = [22, 7, 4].map(index => homepagePhotos[index].url);
const venuePhotos = [6, 0, 5, 11].map(index => homepagePhotos[index].url);

function shuffledPhotos(urls: readonly string[]) {
  const photos = [...urls];
  for (let index = photos.length - 1; index > 0; index--) {
    const next = Math.floor(Math.random() * (index + 1));
    [photos[index], photos[next]] = [photos[next], photos[index]];
  }
  return photos;
}

type JourneySceneProps = {
  step: 0 | 1 | 2;
  artistName?: string;
  artistImage?: PlaceImage;
  venueName?: string;
  venueImage?: PlaceImage;
  timeLabel?: string;
};

/** A decorative journey board; the form owns all labels, state and controls. */
export function JourneyScene({ step, artistName, artistImage, venueName, venueImage, timeLabel }: JourneySceneProps) {
  const [fallbackPhotos] = useState(() => ({music: shuffledPhotos(musicPhotos), venue: shuffledPhotos(venuePhotos)}));
  const [failedPhotos, setFailedPhotos] = useState<readonly string[]>([]);
  const handlePhotoError = useCallback((url: string) => {
    setFailedPhotos(failed => failed.includes(url) ? failed : [...failed.slice(-23), url]);
  }, []);
  return (
    <div className="journey-scene" data-step={step} aria-hidden="true">
      <div className="journey-scene__board">
        <div className="journey-scene__ground" />
        <svg className="journey-scene__route journey-scene__route--full" viewBox="0 0 280 350" fill="none">
          <path className="journey-scene__route-base" d="M68 80C56 135 216 116 212 177S51 243 84 287" />
          <path className="journey-scene__route-progress" pathLength="1" d="M68 80C56 135 216 116 212 177S51 243 84 287" />
          <circle className="journey-scene__route-start" cx="68" cy="80" r="5" />
          <circle className="journey-scene__route-end" cx="84" cy="287" r="5" />
        </svg>
        <svg className="journey-scene__route journey-scene__route--compact" viewBox="0 0 390 150" fill="none">
          <path className="journey-scene__route-base" d="M60 77C107 10 157 131 195 81S302 36 335 71" />
          <path className="journey-scene__route-progress" pathLength="1" d="M60 77C107 10 157 131 195 81S302 36 335 71" />
        </svg>

        <div className="journey-scene__memory journey-scene__memory--music" data-active={step === 0} data-reached={step >= 0}>
          <div className="journey-scene__record"><span><Icon name="music" size={19} /></span></div>
          <div className="journey-scene__sleeve">
            <JourneyPhoto image={artistImage} fallbackUrls={fallbackPhotos.music} failedUrls={failedPhotos} onPhotoError={handlePhotoError} />
            <span className="journey-scene__sleeve-mark"><Icon name="music" size={14} /></span>
          </div>
          {artistName && <span className="journey-scene__caption journey-scene__caption--artist">{artistName}</span>}
        </div>

        <div className="journey-scene__memory journey-scene__memory--place" data-active={step === 1} data-reached={step >= 1}>
          <div className="journey-scene__postcard">
            <JourneyPhoto image={venueImage} fallbackUrls={fallbackPhotos.venue} failedUrls={failedPhotos} onPhotoError={handlePhotoError} />
            <span className="journey-scene__postcard-line" />
            <span className="journey-scene__postcard-line journey-scene__postcard-line--short" />
          </div>
          <span className="journey-scene__pin"><Icon name="pin" size={24} /></span>
          {venueName && <span className="journey-scene__caption journey-scene__caption--venue">{venueName}</span>}
        </div>

        <div className="journey-scene__memory journey-scene__memory--time" data-active={step === 2} data-reached={step >= 2}>
          <div className="journey-scene__ticket">
            <div className="journey-scene__ticket-print">
              <span className="journey-scene__ticket-brand">Dayriff<span>.</span></span>
              {artistName && <span className="journey-scene__ticket-artist">{artistName}</span>}
              {venueName && <span className="journey-scene__ticket-venue">{venueName}</span>}
            </div>
            <span className="journey-scene__ticket-stub"><Icon name="music" size={14} /></span>
            <div className="journey-scene__ticket-time"><Icon name="clock" size={13} />{timeLabel && <span>{timeLabel}</span>}</div>
            <span className="journey-scene__ticket-bars" />
          </div>
        </div>
      </div>
    </div>
  );
}
