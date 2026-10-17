import {useState, type CSSProperties} from 'react';
import {homepagePhotos} from './homepage-photos';
import './HomepageBackdrop.css';

const emptyPhoto = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const turns = [-9, 7, -4, 11, -7, 5, 8, -12, 6, -5];
const offsets = [0, -2, 2, -1, 1, -2, 1, 0, -1, 2];

function GalleryPhoto({photo, index}: {photo: typeof homepagePhotos[number]; index: number}) {
  const [loaded, setLoaded] = useState(false);
  const style = {
    '--photo-x': `${index % 6 * 19 + 2 + offsets[index % offsets.length]}%`,
    '--photo-y': `${Math.floor(index / 6) * 24 + 2 + offsets[(index + 3) % offsets.length]}%`,
    '--photo-turn': `${turns[index % turns.length]}deg`,
    '--photo-layer': (index * 7) % 17,
  } as CSSProperties;
  const format = index % 5 === 0 ? 'portrait' : index % 3 === 0 ? 'landscape' : 'square';
  return <div className={`homepage-gallery__print homepage-gallery__print--${format}${index >= 6 ? ' homepage-gallery__print--desktop' : ''}`} style={style}>
    <div className={`homepage-gallery__photo${loaded ? ' homepage-gallery__photo--loaded' : ''}`}>
      <picture>
        <source media={index < 6 ? '(min-width: 0px)' : '(min-width: 960px)'} srcSet={photo.url} />
        <img src={emptyPhoto} alt="" width="420" height="420" loading="lazy" decoding="async" fetchPriority="low" referrerPolicy="no-referrer"
          onLoad={event => setLoaded(event.currentTarget.currentSrc.startsWith('https://images.qloo.com/i/'))} onError={() => setLoaded(false)} />
      </picture>
    </div>
  </div>;
}

/** One softly focused spread of photo prints; the planning panel remains still and clear. */
export function HomepageBackdrop() {
  return <>
    <div className="homepage-backdrop" aria-hidden="true">
      <div className="homepage-gallery">{homepagePhotos.map((photo, index) => <GalleryPhoto key={photo.url} photo={photo} index={index} />)}</div>
      <div className="homepage-backdrop__veil" />
    </div>
  </>;
}
