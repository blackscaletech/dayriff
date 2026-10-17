import {createContext} from 'react';

export const HOME_HREF = '/?view=home';
export const HomeNavigationContext = createContext<(() => void) | null>(null);

type Navigation = {path: string; home: boolean};
const homeStateKey = 'dayriffView';

export function currentNavigation(): Navigation {
  return {path: window.location.pathname, home: window.location.pathname === '/' && (new URLSearchParams(window.location.search).get('view') === 'home' || window.history.state?.[homeStateKey] === 'home')};
}

export function changeNavigation(home: boolean, replace = false): Navigation {
  const state = {...window.history.state, [homeStateKey]: home ? 'home' : 'plan'};
  window.history[replace ? 'replaceState' : 'pushState'](state, '', '/');
  return {path: '/', home};
}
