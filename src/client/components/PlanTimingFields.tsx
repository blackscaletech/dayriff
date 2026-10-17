import type {Budget} from '../../shared/types';
import {durationLabel} from '../format';
import {DateTimeControl} from './DateTimeControl';
import {ChoiceControl} from './ChoiceControl';
import {Icon} from './Icon';
import './PlanTimingFields.css';

export type TimingDraft = {date: string; showTime: string; duration: number; arrivalBy: string; budget: Budget | ''};
const durationChoices = [{value: '90', label: '90 min'}, {value: '120', label: '2 hr'}, {value: '180', label: '3 hr'}, {value: '240', label: '4 hr'}, {value: '300', label: '5 hr'}, {value: '360', label: '6 hr'}];

export function PlanTimingFields({value, onChange, scheduleError, errorId, optionalOpen, onOptionalOpen}: {
  value: TimingDraft; onChange: (patch: Partial<TimingDraft>) => void;
  scheduleError: string; errorId: string; optionalOpen: boolean; onOptionalOpen: (open: boolean) => void;
}) {
  const options = durationChoices.some(choice => Number(choice.value) === value.duration) ? durationChoices : [...durationChoices, {value: String(value.duration), label: durationLabel(value.duration)}].sort((a, b) => Number(a.value) - Number(b.value));
  return <div className="journey-timing">
    <div className="form-group form-group--outing">
      <div className="field field--inline"><label htmlFor="plan-date">Show date</label><DateTimeControl id="plan-date" label="Show date" type="date" value={value.date} onChange={date => onChange({date})} required /></div>
      <div className="field field--inline"><label htmlFor="plan-show">Show time</label><DateTimeControl id="plan-show" label="Show time" type="time" value={value.showTime} onChange={showTime => onChange({showTime})} required /></div>
      <div className="field field--inline"><label htmlFor="plan-duration">Time to explore</label><ChoiceControl id="plan-duration" title="Time to explore" value={String(value.duration)} onChange={duration => onChange({duration: Number(duration)})} options={options} /></div>
    </div>
    <details className="optional-fields" open={optionalOpen} onToggle={event => onOptionalOpen(event.currentTarget.open)}>
      <summary><span>Arrival time or budget</span><span className="optional-label">Optional<Icon name="chevron" size={15} /></span></summary>
      <div className="optional-fields__body">
        <div className="field field--inline"><label htmlFor="plan-arrival">Arrive at venue by</label><DateTimeControl id="plan-arrival" label="Arrive at venue by" type="time" value={value.arrivalBy} onChange={arrivalBy => onChange({arrivalBy})} clearLabel="Clear arrival time" describedBy={scheduleError ? errorId : undefined} invalid={Boolean(scheduleError)} /></div>
        <div className="field field--inline"><label htmlFor="plan-budget">Budget preference</label><ChoiceControl id="plan-budget" title="Budget preference" value={value.budget} onChange={budget => onChange({budget: budget as Budget | ''})} options={[
          {value: '', label: 'No preference', detail: 'Leave budget out of your recommendations.'}, {value: 'low', label: 'Keep it low · $', compactLabel: 'Low · $'}, {value: 'medium', label: 'Moderate · $$'}, {value: 'high', label: 'Flexible · $$$'},
        ]} /></div>
      </div>
    </details>
    {scheduleError && <p id={errorId} className="plan-form__schedule-error" role="alert"><Icon name="clock" size={16} /><span>{scheduleError}</span></p>}
  </div>;
}
