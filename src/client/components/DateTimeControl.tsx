import {useId, useRef, useState} from 'react';
import {dateLabel, timeLabel} from '../format';
import {Icon} from './Icon';
import {Sheet} from './Sheet';
import {CalendarPicker} from './date-time/CalendarPicker';
import {TimePicker} from './date-time/TimePicker';
import {dateInRange, dateSeed, timeInRange, timeSeed} from './date-time/values';
import './DateTimeControl.css';

type DateTimeControlProps = {
  id: string; type: 'date' | 'time'; value: string; onChange: (value: string) => void;
  label?: string; required?: boolean; min?: string; max?: string; emptyLabel?: string; clearLabel?: string; describedBy?: string; invalid?: boolean;
};

export function DateTimeControl({id, type, value, onChange, label, required = false, min, max, emptyLabel, clearLabel = 'Clear time', describedBy, invalid}: DateTimeControlProps) {
  const trigger = useRef<HTMLButtonElement>(null), valueId = useId();
  const [open, setOpen] = useState(false), [draft, setDraft] = useState('');
  const formatted = value ? type === 'date' ? dateLabel(value) : timeLabel(value) : emptyLabel ?? (type === 'date' ? 'Set date' : 'Set time');
  const year = type === 'date' && value ? Number(value.slice(0, 4)) : undefined;
  const display = year && year !== new Date().getFullYear() ? `${formatted}, ${year}` : formatted;
  const valid = type === 'date' ? dateInRange(draft, min, max) : timeInRange(draft, min, max);
  function reveal() {setDraft(type === 'date' ? dateSeed(value, min, max) : timeSeed(value, min, max)); setOpen(true);}
  function close() {setOpen(false); requestAnimationFrame(() => trigger.current?.focus());}
  function confirm() {if (valid) {onChange(draft); close();}}
  return <div className="date-time-control">
    <button ref={trigger} id={id} className={`value-control date-time-control__trigger${value ? '' : ' date-time-control__trigger--empty'}`} type="button" aria-haspopup="dialog" aria-expanded={open} aria-describedby={`${valueId}${describedBy ? ` ${describedBy}` : ''}`} aria-invalid={invalid || undefined} onClick={reveal}><span id={valueId}>{display}</span><Icon name={type === 'date' ? 'calendar' : 'clock'} size={15} /></button>
    <input type={type} name={id} value={value} required={required} min={min} max={max} hidden tabIndex={-1} onChange={event => onChange(event.target.value)} onInvalid={event => {event.preventDefault(); reveal();}} />
    {!required && value && <button className="date-time-control__clear" type="button" aria-label={clearLabel} onClick={() => {onChange(''); trigger.current?.focus();}}><Icon name="close" size={14} /></button>}
    <Sheet compact flush open={open} onClose={close} title={label ?? (type === 'date' ? 'Choose date' : 'Choose time')}>
      {open && <div className="date-time-picker" onKeyDown={event => {if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {event.preventDefault(); confirm();}}}>
        {type === 'date' ? <CalendarPicker value={draft} onChange={setDraft} min={min} max={max} /> : <TimePicker value={draft} onChange={setDraft} />}
        {!valid && <p className="date-time-picker__validation" role="status">{!draft ? 'Choose a valid time.' : min && max ? `Choose ${type === 'date' ? 'a date' : 'a time'} within the allowed range.` : min ? `Choose ${type === 'date' ? 'a date' : 'a time'} at or after ${type === 'date' ? dateLabel(min) : timeLabel(min)}.` : max ? `Choose ${type === 'date' ? 'a date' : 'a time'} at or before ${type === 'date' ? dateLabel(max) : timeLabel(max)}.` : 'Choose a valid value.'}</p>}
        <div className="date-time-picker__confirmation"><button className="button button--primary" type="button" disabled={!valid} onClick={confirm}>Done</button></div>
      </div>}
    </Sheet>
  </div>;
}
