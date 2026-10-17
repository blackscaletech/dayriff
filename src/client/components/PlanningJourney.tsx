import {useCallback, useState} from 'react';
import type {PlaceImage} from '../../shared/types';
import {JourneyPhoto} from './JourneyPhoto';
import {homepagePhotos} from './homepage-photos';
import './PlanningJourney.css';

const musicPhotos = [22, 7, 4].map(index => homepagePhotos[index].url);
const venuePhotos = [6, 0, 5, 11].map(index => homepagePhotos[index].url);

type PlanningJourneyProps = {artist: string; venue: string; artistImage?: PlaceImage; venueImage?: PlaceImage};

export function PlanningJourney({artist, venue, artistImage, venueImage}: PlanningJourneyProps) {
  const [failedPhotos, setFailedPhotos] = useState<readonly string[]>([]);
  const handlePhotoError = useCallback((url: string) => {
    setFailedPhotos(failed => failed.includes(url) ? failed : [...failed.slice(-15), url]);
  }, []);
  return <div className="planning-journey" role="status" aria-live="polite">
    <div className="planning-journey__art" aria-hidden="true">
      <span className="planning-journey__halo" />
      <svg className="planning-journey__route" viewBox="0 0 360 360" fill="none">
        <path className="planning-journey__track" d="M74 129C69 47 230 27 288 121S264 305 168 310 31 221 74 129Z" />
        <path className="planning-journey__trail" pathLength="360" d="M74 129C69 47 230 27 288 121S264 305 168 310 31 221 74 129Z" />
      </svg>
      <div className="planning-journey__memory planning-journey__memory--music">
        <span className="planning-journey__record"><span /></span>
        <div className="planning-journey__sleeve"><JourneyPhoto image={artistImage} fallbackUrls={musicPhotos} failedUrls={failedPhotos} onPhotoError={handlePhotoError} /></div>
      </div>
      <div className="planning-journey__memory planning-journey__memory--venue">
        <div className="planning-journey__postcard"><JourneyPhoto image={venueImage} fallbackUrls={venuePhotos} failedUrls={failedPhotos} onPhotoError={handlePhotoError} /><span className="planning-journey__postcard-line" /><span className="planning-journey__postcard-line planning-journey__postcard-line--short" /></div>
      </div>
      <span className="planning-journey__waypoint" />
    </div>
    <h2>Building your plan…</h2>
    <p className="planning-journey__context"><span>{artist}</span><span aria-hidden="true">·</span><span>{venue}</span></p>
  </div>;
}
