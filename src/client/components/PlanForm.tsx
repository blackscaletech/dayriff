import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import type {AppConfig, Artist, City, PlanInput, Venue} from '../../shared/types';
import {derivePlanningWindow} from '../../shared/planning-window';
import {api} from '../api';
import {useMediaQuery} from '../hooks/useMediaQuery';
import {durationLabel, timeLabel} from '../format';
import {describeFailure, type ClientFailure} from '../failures';
import {journeyAction, journeyFailureStep, reachableJourneyStep, type JourneyStep} from '../journey-flow';
import {SearchField} from './SearchField';
import {FieldInput} from './FieldInput';
import {VenueField} from './VenueField';
import {Icon} from './Icon';
import {PlanningJourney} from './PlanningJourney';
import {FailureNotice} from './FailureNotice';
import {JourneyScene} from './JourneyScene';
import {JourneySteps} from './JourneySteps';
import {PlanTimingFields, type TimingDraft} from './PlanTimingFields';
import {dateInRange, timeInRange} from './date-time/values';
import './PlanForm.css';

function tomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const artistDetail = (artist: Artist) => artist.detail;

export function PlanForm({config, initial, initialVenue, busy, failure, onSubmit, onRetry, onClearFailure}: {
  config: AppConfig; initial?: PlanInput; initialVenue?: Venue; busy: boolean; failure: ClientFailure | null;
  onSubmit: (input: PlanInput) => void; onRetry: () => void; onClearFailure: () => void;
}) {
  const sample = config.mode === 'sample';
  const [step, setStep] = useState<JourneyStep>(initial ? 2 : 0);
  const [furthestStep, setFurthestStep] = useState<JourneyStep>(initial ? 2 : 0);
  const stacked = useMediaQuery('(max-width: 700px)') && !initial;
  const actionStep = initial ? 2 : stacked ? furthestStep : step;
  const [artist, setArtist] = useState<Artist | null>(initial?.artist ?? (sample ? config.sampleArtists[0] : null));
  const [venue, setVenue] = useState<Venue | null>(initialVenue ?? config.venues.find(item => item.id === initial?.venueId) ?? (sample ? config.venues[0] : null));
  const [timing, setTiming] = useState<TimingDraft>({date: initial?.date ?? tomorrow(), showTime: initial?.showTime ?? '19:00', duration: initial?.durationMinutes ?? 180, arrivalBy: initial?.arrivalBy ?? '', budget: initial?.budget ?? ''});
  const [startingPoint, setStartingPoint] = useState(() => {
    const value = initial?.startingPoint ?? '';
    return /^(venue|near the venue)$/i.test(value.trim()) ? '' : value;
  });
  const [optionalOpen, setOptionalOpen] = useState(Boolean(initial?.arrivalBy || initial?.budget));
  const [city, setCity] = useState<City | null>(null);
  const [fieldErrors, setFieldErrors] = useState({artist: '', venue: ''});
  const artistRef = useRef<HTMLInputElement>(null), venueRef = useRef<HTMLInputElement>(null), startingRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null), generalNotice = useRef<HTMLDivElement>(null);
  const startingFeedbackId = useId(), scheduleFeedbackId = useId();
  let planningWindow: ReturnType<typeof derivePlanningWindow> | undefined, scheduleError = '';
  try {planningWindow = derivePlanningWindow({date: timing.date, showTime: timing.showTime, durationMinutes: timing.duration, ...(timing.arrivalBy ? {arrivalBy: timing.arrivalBy} : {})});}
  catch (error) {scheduleError = error instanceof RangeError ? error.message : 'Choose your show date and time.';}
  const presentation = failure ? describeFailure(failure) : null;
  const startingFailure = presentation?.location === 'startingPoint' ? failure : null;
  const selectionFailure = presentation?.location === 'artist' || presentation?.location === 'venue' ? failure : null;
  const ready = {artist: Boolean(artist), venue: Boolean(venue), schedule: Boolean(planningWindow)};
  const reachable = reachableJourneyStep(2, ready);

  function focusElement(element: HTMLElement | null | undefined) {
    if (!element) return;
    element.focus({preventScroll: true});
    const bounds = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = (viewport?.offsetTop ?? 0) + 16;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 16;
    if (bounds.top < top || bounds.bottom > bottom) element.scrollIntoView({block: bounds.height > bottom - top ? 'start' : 'nearest', behavior: 'auto'});
  }
  function revealStep(next: JourneyStep, focus = true) {
    setFurthestStep(current => Math.max(current, next) as JourneyStep);
    onClearFailure();
    setStep(next);
    if (focus) requestAnimationFrame(() => {
      const selected = next === 0 ? artist : next === 1 ? venue : true;
      const stage = formRef.current?.querySelector<HTMLElement>(`.journey-stage--${next === 0 ? 'artist' : next === 1 ? 'place' : 'timing'}`);
      focusElement(selected ? stage : next === 0 ? artistRef.current : venueRef.current);
    });
  }
  useEffect(() => {
    if (busy || !failure) return;
    const location = describeFailure(failure).location;
    const next = journeyFailureStep(location);
    if (next !== undefined) setStep(next);
    const frame = requestAnimationFrame(() => {
      if (location === 'startingPoint') focusElement(startingRef.current);
      else if (location === 'artist') focusElement(artistRef.current);
      else if (location === 'venue') focusElement(venueRef.current);
      else generalNotice.current?.scrollIntoView({block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    });
    return () => cancelAnimationFrame(frame);
  }, [failure, busy]);

  function changeStartingPoint(value: string) {setStartingPoint(value); onClearFailure();}
  function chooseArtist(value: Artist | null) {onClearFailure(); setArtist(value); setFieldErrors(current => ({...current, artist: ''}));}
  function chooseVenue(value: Venue | null) {onClearFailure(); setVenue(value); setFieldErrors(current => ({...current, venue: ''}));}
  function changeTiming(patch: Partial<TimingDraft>) {setTiming(current => ({...current, ...patch})); onClearFailure();}
  function reselect() {
    if (presentation?.location === 'artist') {chooseArtist(null); focusElement(artistRef.current);}
    else {chooseVenue(null); focusElement(venueRef.current);}
  }
  function focusSchedule() {
    const control = !dateInRange(timing.date) ? '#plan-date' : !timeInRange(timing.showTime) ? '#plan-show' : !Number.isInteger(timing.duration) || timing.duration < 30 || timing.duration > 480 ? '#plan-duration' : '#plan-arrival';
    if (control === '#plan-arrival') setOptionalOpen(true);
    requestAnimationFrame(() => focusElement(formRef.current?.querySelector<HTMLElement>(control)));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const action = journeyAction(actionStep, ready);
    if (action.kind === 'advance') {revealStep(action.step); return;}
    if (action.kind === 'incomplete') {
      setStep(action.step);
      if (action.field === 'artist') {setFieldErrors(current => ({...current, artist: 'Choose the artist you’re seeing.'})); requestAnimationFrame(() => focusElement(artistRef.current));}
      else if (action.field === 'venue') {setFieldErrors(current => ({...current, venue: city ? 'Choose a concert venue in this city.' : 'Choose your concert venue, or search for a city.'})); requestAnimationFrame(() => focusElement(venueRef.current));}
      else focusSchedule();
      return;
    }
    if (!artist || !venue) return;
    setFieldErrors({artist: '', venue: ''});
    onSubmit({artist, venueId: venue.id, date: timing.date, showTime: timing.showTime, durationMinutes: timing.duration, startingPoint: startingPoint.trim() || 'Near the venue',
      ...(timing.arrivalBy ? {arrivalBy: timing.arrivalBy} : {}), ...(timing.budget ? {budget: timing.budget} : {}),
    });
  }

  if (busy) return <PlanningJourney artist={artist?.name ?? 'Your music'} artistImage={artist?.image} venue={venue?.name ?? 'Your venue'} venueImage={venue?.image} />;

  return <form ref={formRef} className={`plan-form${initial ? ' plan-form--editing' : ' theme-onboarding'}`} noValidate onSubmit={submit} aria-label="Plan your day">
    {!initial && furthestStep > 0 && <JourneySteps step={step} values={[artist?.name ?? '', venue?.name ?? '', durationLabel(timing.duration)]} revealed={Math.min(furthestStep, reachable) as JourneyStep} onChange={requested => revealStep(reachableJourneyStep(requested, ready))} />}
    <div className="journey-layout">
      {!initial && <JourneyScene step={step} artistName={artist?.name} artistImage={artist?.image} venueName={venue?.name} venueImage={venue?.image} timeLabel={timeInRange(timing.showTime) ? timeLabel(timing.showTime) : undefined} />}
      <div className="journey-workspace">
        <fieldset className="form-fields" disabled={busy}>
          <section className="journey-stage journey-stage--artist" aria-label="Artist" tabIndex={-1} data-current={Boolean(initial) || step === 0} data-reached={Boolean(initial) || furthestStep >= 0} onFocusCapture={() => {if (stacked) setStep(0);}}>
            <div className="form-group">
              <SearchField label="Who are you seeing?" placeholder="Search for an artist" value={artist} onChange={chooseArtist} initialOptions={config.sampleArtists} search={api.artists} detail={artistDetail} icon="music" inputRef={artistRef} errorText={fieldErrors.artist} emptyText="Try the artist’s full name." />
              {selectionFailure && presentation?.location === 'artist' && <div className="plan-form__field-feedback"><FailureNotice failure={selectionFailure} inline action={{label: 'Choose artist', onClick: reselect}} /></div>}
            </div>
          </section>
          <section className="journey-stage journey-stage--place" aria-label="Venue" tabIndex={-1} data-current={Boolean(initial) || step === 1} data-reached={Boolean(initial) || furthestStep >= 1} onFocusCapture={() => {if (stacked) setStep(1);}}>
            <div className="form-group">
              <VenueField value={venue} onChange={chooseVenue} city={city} onCityChange={value => {setCity(value); onClearFailure();}} initialVenues={config.venues} inputRef={venueRef} errorText={fieldErrors.venue} />
              {selectionFailure && presentation?.location === 'venue' && <div className="plan-form__field-feedback"><FailureNotice failure={selectionFailure} inline action={{label: 'Choose venue', onClick: reselect}} /></div>}
              <div className={`field starting-point${startingFailure ? ' starting-point--needs-attention' : ''}`}>
                <label htmlFor="plan-starting-point">Starting from</label>
                <span id="plan-starting-hint" className="sr-only">Enter an address or neighborhood, or leave blank to start near the venue.</span>
                <FieldInput icon="pin">
                  <input ref={startingRef} id="plan-starting-point" name="startingPoint" type="text" autoComplete="street-address" autoCapitalize="words" maxLength={240} value={startingPoint} placeholder="Near the venue" aria-describedby={`plan-starting-hint${startingFailure ? ` ${startingFeedbackId}` : ''}`} aria-invalid={startingFailure ? true : undefined} onChange={event => changeStartingPoint(event.target.value)} />
                  {startingPoint && <button className="starting-point__clear" type="button" aria-label="Clear starting point" onClick={() => {changeStartingPoint(''); startingRef.current?.focus();}}><span><Icon name="close" size={12} /></span></button>}
                </FieldInput>
                {startingFailure && <div className="starting-point__feedback"><FailureNotice failure={startingFailure} inline messageId={startingFeedbackId} action={{label: 'Edit starting point', onClick: () => {startingRef.current?.focus(); startingRef.current?.select();}}} secondaryAction={{label: 'Use venue', onClick: () => {changeStartingPoint(''); startingRef.current?.focus();}}} /></div>}
              </div>
            </div>
          </section>
          <section className="journey-stage journey-stage--timing" aria-label="Time" tabIndex={-1} data-current={Boolean(initial) || step === 2} data-reached={Boolean(initial) || furthestStep >= 2} onFocusCapture={() => {if (stacked) setStep(2);}}>
            <PlanTimingFields value={timing} onChange={changeTiming} scheduleError={scheduleError} errorId={scheduleFeedbackId} optionalOpen={optionalOpen} onOptionalOpen={setOptionalOpen} />
          </section>
        </fieldset>
        {failure && presentation?.location === 'general' && <div ref={generalNotice} className="plan-form__failure"><FailureNotice failure={failure} action={presentation.recovery === 'retry' ? {label: 'Try again', onClick: failure.operation === 'create' ? () => formRef.current?.requestSubmit() : onRetry} : presentation.recovery === 'editPlan' ? {label: 'Review details', onClick: () => {onClearFailure(); revealStep(0);}} : undefined} /></div>}
        <div className="plan-form__actions">
          {!initial && step > 0 && <button className="icon-control plan-form__back" type="button" aria-label={step === 1 ? 'Back to artist' : 'Back to venue'} onClick={() => revealStep((step - 1) as JourneyStep)}><Icon name="arrow" size={19} /></button>}
          <button className="button button--primary" type="submit">{initial ? 'Update my places' : actionStep === 2 ? 'Find my places' : 'Continue'}<Icon name="arrow" size={18} /></button>
        </div>
      </div>
    </div>
  </form>;
}
