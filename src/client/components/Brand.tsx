import {useContext} from 'react';
import {HOME_HREF, HomeNavigationContext} from '../home-navigation';
import './Brand.css';

export function Brand({className = '', onNavigate}: {className?: string; onNavigate?: () => void}) {
  const navigateHome = useContext(HomeNavigationContext);
  return <a className={`brand${className ? ` ${className}` : ''}`} href={HOME_HREF} aria-label="Dayriff home" onClick={event => {
    if (!navigateHome || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onNavigate?.(); navigateHome();
  }}>Dayriff<span>.</span></a>;
}
