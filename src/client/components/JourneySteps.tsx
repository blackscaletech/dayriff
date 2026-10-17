import type {JourneyStep} from '../journey-flow';
import {Icon} from './Icon';
import './JourneySteps.css';

const stages = [
  {label: 'Artist', icon: 'music'},
  {label: 'Venue', icon: 'pin'},
  {label: 'Time', icon: 'clock'},
] as const;

export function JourneySteps({step, values, revealed, onChange}: {
  step: JourneyStep; values: [string, string, string]; revealed: JourneyStep; onChange: (step: JourneyStep) => void;
}) {
  return <nav className="journey-steps" aria-label="Plan your day steps"><ol>
    {stages.slice(0, revealed + 1).map((stage, index) => <li key={stage.label}>
      <button type="button" className="journey-step button button--glass" aria-label={`${stage.label}${values[index] ? `: ${values[index]}` : ''}`} aria-current={step === index ? 'step' : undefined}
        onClick={() => onChange(index as JourneyStep)}>
        <span className="journey-step__mark"><Icon name={stage.icon} size={18} /></span>
        <span className="journey-step__label">{stage.label}</span>
      </button>
    </li>)}
  </ol></nav>;
}
