import {useState} from 'react';
import {Icon} from './Icon';
import {Brand} from './Brand';
import {Sheet} from './Sheet';
import {TripPrivacy} from './TripPrivacy';
import './SiteFooter.css';

type SiteFooterProps = {photos?: boolean; docked?: boolean; tripBusy?: boolean; clearing?: boolean; onClearTrip?: () => Promise<void>};

export function SiteFooter({photos = false, docked = false, tripBusy = false, clearing = false, onClearTrip}: SiteFooterProps) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  return <>
    <footer className={`site-footer${photos ? ' site-footer--photos' : ''}${docked ? ' site-footer--docked' : ''}`}>
      {photos && <a className="button button--glass button--small site-footer__control site-footer__photo-credit" href="https://www.qloo.com/" target="_blank" rel="noopener noreferrer">Photos via Qloo<Icon name="external" size={12} /><span className="sr-only"> (opens in a new tab)</span></a>}
      <button className="button button--glass button--small site-footer__control" type="button" aria-haspopup="dialog" aria-expanded={aboutOpen} onClick={() => setAboutOpen(true)}>About</button>
    </footer>
    <Sheet open={aboutOpen} onClose={() => setAboutOpen(false)} title="Dayriff" titleContent={<Brand onNavigate={() => setAboutOpen(false)} />} className="site-about-sheet" compact>
      <div className="site-about">
        <p className="site-about__lead">Make a day of the show.</p>
        <p className="site-about__description">Discover nearby places inspired by who you’re seeing, with a walking route that ends at your venue.</p>
        <p className="site-about__signature"><span>Made by</span> <a className="site-about__author" href="https://x.com/ivanciraj" target="_blank" rel="noopener noreferrer">Ivan Ciraj<Icon name="external" size={13} /><span className="sr-only"> (opens in a new tab)</span></a></p>
        {onClearTrip && <button className="button button--glass site-about__privacy" type="button" onClick={() => {setAboutOpen(false); setPrivacyOpen(true);}}>Privacy & trip data<Icon name="chevron" size={15} /></button>}
      </div>
    </Sheet>
    {onClearTrip && <TripPrivacy open={privacyOpen} onClose={() => setPrivacyOpen(false)} onBack={() => {setPrivacyOpen(false); setAboutOpen(true);}} busy={tripBusy} clearing={clearing} onClearTrip={onClearTrip} />}
  </>;
}
