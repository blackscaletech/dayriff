import {useState} from 'react';
import {Icon} from './Icon';
import {Sheet} from './Sheet';
import './ChoiceControl.css';

type Choice = {value: string; label: string; detail?: string; compactLabel?: string};
export function ChoiceControl({id, title, value, options, onChange}: {
  id: string; title: string; value: string; options: Choice[]; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  return <div className="choice-control">
    <button id={id} className="value-control" type="button" aria-label={`${title}: ${selected?.label ?? ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span>{selected?.compactLabel ?? selected?.label}</span><Icon name="chevron" size={15} />
    </button>
    <Sheet compact open={open} onClose={() => setOpen(false)} title={title}>
      <div className="choice-control__options">
        {options.map(option => <button key={option.value} type="button" className="choice-control__option" aria-pressed={option.value === value} onClick={() => {onChange(option.value); setOpen(false);}}>
          <span><span className="choice-control__label">{option.label}</span>{option.detail && <span className="choice-control__detail">{option.detail}</span>}</span>
          <span className="choice-control__mark" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
        </button>)}
      </div>
    </Sheet>
  </div>;
}
