import {useEffect, useState} from 'react';
import type {AppConfig} from '../shared/types';
import {api} from './api';
import {toFailure, type ClientFailure} from './failures';
import {Icon} from './components/Icon';
import {PlanForm} from './components/PlanForm';
import {ItineraryView} from './components/ItineraryView';
import {usePlanner} from './hooks/usePlanner';
import {FailureNotice} from './components/FailureNotice';
import {HomepageBackdrop} from './components/HomepageBackdrop';
import {Brand} from './components/Brand';
import {SiteFooter} from './components/SiteFooter';
import {SharedTripPage} from './components/SharedTripPage';
import {changeNavigation, currentNavigation, HOME_HREF, HomeNavigationContext} from './home-navigation';
import './App.css';

export default function App() {
  const [navigation, setNavigation] = useState(currentNavigation);
  useEffect(() => {
    if (navigation.home && window.location.search) setNavigation(changeNavigation(true, true));
    const restoreNavigation = () => setNavigation(currentNavigation());
    window.addEventListener('popstate', restoreNavigation);
    return () => window.removeEventListener('popstate', restoreNavigation);
  }, []);
  function goHome() {
    if (navigation.path.startsWith('/shared/')) {window.location.assign(HOME_HREF); return;}
    if (!navigation.home || navigation.path !== '/') setNavigation(changeNavigation(true));
    window.scrollTo({top: 0});
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#main .planning-screen h1')?.focus({preventScroll: true}));
  }
  function showPlan() {setNavigation(changeNavigation(false, true));}
  return <HomeNavigationContext.Provider value={goHome}>{navigation.path.startsWith('/shared/')
    ? <SharedTripPage token={navigation.path.slice('/shared/'.length).replace(/\/$/, '')} />
    : <PlannerApp homeRequested={navigation.home} onShowPlan={showPlan} />}</HomeNavigationContext.Provider>;
}
function PlannerApp({homeRequested, onShowPlan}: {homeRequested: boolean; onShowPlan: () => void}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configFailure, setConfigFailure] = useState<ClientFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const planner = usePlanner(config?.mode ?? null);
  useEffect(() => {
    if (homeRequested) {planner.cancelEdit(); planner.clearFailure();}
  }, [homeRequested]);
  useEffect(() => {
    const controller = new AbortController();
    setConfigFailure(null);
    void api.config(controller.signal).then(setConfig).catch((reason: unknown) => {
      if (!controller.signal.aborted) setConfigFailure(toFailure(reason, 'config'));
    });
    return () => controller.abort();
  }, [attempt]);
  function returnToPlan() {
    planner.cancelEdit(); onShowPlan();
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#main h1')?.focus({preventScroll: true}));
  }
  const homepage = Boolean(config && !planner.restoring && (!planner.plan || homeRequested));
  const showPlan = Boolean(planner.plan && !planner.editing && !homepage);
  const editingPlan = planner.editing && !homepage;
  return <div className={`app-shell${homepage ? ` app-shell--home${planner.busy ? '' : ' app-shell--onboarding'}` : ''}`}>
    {homepage && <HomepageBackdrop />}
    <a className="skip-link" href="#main">Skip to content</a>
    {!homepage && <header className="site-header"><Brand /></header>}
    <main id="main" className="main-content">
      {!config || planner.restoring ? <div className="connection-state" role={configFailure ? undefined : 'status'}>
        {configFailure ? <><h1 className="sr-only">Unable to connect</h1><FailureNotice failure={configFailure} action={{label: 'Try again', onClick: () => setAttempt(current => current + 1)}} /></> : <><span className="spinner" /><p>Loading your plan…</p></>}
      </div> : <>
        {planner.plan && <div hidden={!showPlan}>
          <ItineraryView plan={planner.plan} messages={planner.messages} history={planner.history} pendingStopId={planner.pendingStopId} pendingKind={planner.pendingKind} previousNames={planner.previousNames} stopNotice={planner.stopNotice} onRestore={planner.restore} onRemoveHistory={planner.removeHistory} removingVersionId={planner.removingVersionId} pendingMessage={planner.pendingMessage} changedStopIds={planner.changedStopIds} updateNotice={planner.updateNotice} busy={planner.busy} failure={planner.failure} onRetry={planner.retry} onEdit={planner.edit} onSwap={(id, name) => {void planner.revise(`Replace ${name} with a different place.`, id);}} onRevise={message => planner.revise(message)} />
        </div>}
        {!showPlan && <div className={`planning-screen${homepage ? ' planning-screen--home' : ''}`}>
          {homepage && <div className="planning-brand-row"><Brand className="planning-brand" />{planner.plan && !planner.busy && <button className="button button--glass button--small" type="button" onClick={returnToPlan}>My plan<Icon name="arrow" size={16} /></button>}</div>}
          {!planner.busy && <header className={`screen-heading${editingPlan ? ' screen-heading--editing' : ''}`}>
            {editingPlan ? <><button className="button button--glass button--small planning-back" type="button" onClick={returnToPlan}><Icon name="chevron" size={18} />Back to my plan</button><h1 tabIndex={-1}>Plan details</h1><p>Update your concert, starting point, or time.</p></> : <><h1 tabIndex={-1}>Make a day of the show.</h1><p>Discover places you’ll love, inspired by who you’re seeing.</p></>}
          </header>}
          <PlanForm key={editingPlan && planner.plan ? `${planner.plan.id}-${planner.plan.revision}` : `first-plan-${planner.formVersion}`} config={config} initial={editingPlan ? planner.plan?.input : undefined} initialVenue={editingPlan ? planner.plan?.venue : undefined} busy={planner.busy} failure={planner.failure} onRetry={() => {void planner.retry();}} onClearFailure={planner.clearFailure} onSubmit={input => {void planner.create(input).then(created => {if (created) onShowPlan();});}} />
          {config.mode === 'sample' && !planner.busy && <p className="preview-note">Sample places and taste connections. Walking times are estimates.</p>}
        </div>}
      </>}
    </main>
    <SiteFooter photos={homepage} docked={showPlan} tripBusy={planner.busy || planner.restoring} clearing={planner.clearing} onClearTrip={planner.clearTrip} />
  </div>;
}
