import {useState, type KeyboardEvent} from 'react';
import {Icon} from '../Icon';
import {clockValue, twelveHour, type ClockPeriod} from './values';
import './TimePicker.css';

export function TimePicker({value, onChange}: {value: string; onChange: (value: string) => void}) {
  const initial = twelveHour(value);
  const [hour, setHour] = useState(String(initial.hour).padStart(2, '0'));
  const [minute, setMinute] = useState(String(initial.minute).padStart(2, '0'));
  const [period, setPeriod] = useState<ClockPeriod>(initial.period);
  const validHour = /^\d{1,2}$/.test(hour) && Number(hour) >= 1 && Number(hour) <= 12;
  const validMinute = /^\d{1,2}$/.test(minute) && Number(minute) <= 59;
  function publish(nextHour: string, nextMinute: string, nextPeriod: ClockPeriod) {
    onChange(nextHour && nextMinute ? clockValue(Number(nextHour), Number(nextMinute), nextPeriod) ?? '' : '');
  }
  function update(part: 'hour' | 'minute', text: string) {
    const next = text.replace(/\D/g, '').slice(0, 2);
    if (part === 'hour') {setHour(next); publish(next, minute, period);}
    else {setMinute(next); publish(hour, next, period);}
  }
  function step(part: 'hour' | 'minute', amount: number) {
    const current = part === 'hour' ? validHour ? Number(hour) : 12 : validMinute ? Number(minute) : 0;
    const next = part === 'hour' ? (current - 1 + amount + 12) % 12 + 1 : (current + amount + 60) % 60;
    update(part, String(next).padStart(2, '0'));
  }
  function onKey(event: KeyboardEvent<HTMLInputElement>, part: 'hour' | 'minute') {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    step(part, event.key === 'ArrowUp' ? 1 : -1);
  }
  return <div className="time-picker">
    <div className="time-picker__part"><span className="time-picker__label">Hour</span><div className="time-picker__well"><button className="time-picker__increase" type="button" aria-label="Increase hour" onClick={() => step('hour', 1)}><Icon name="chevron" size={19} /></button><input type="text" inputMode="numeric" role="spinbutton" aria-label="Hour" aria-valuemin={1} aria-valuemax={12} aria-valuenow={validHour ? Number(hour) : undefined} aria-invalid={!validHour || undefined} value={hour} maxLength={2} onFocus={event => event.currentTarget.select()} onChange={event => update('hour', event.target.value)} onBlur={() => {if (validHour) setHour(hour.padStart(2, '0'));}} onKeyDown={event => onKey(event, 'hour')} /><button type="button" aria-label="Decrease hour" onClick={() => step('hour', -1)}><Icon name="chevron" size={19} /></button></div></div>
    <span className="time-picker__colon" aria-hidden="true">:</span>
    <div className="time-picker__part"><span className="time-picker__label">Minute</span><div className="time-picker__well"><button className="time-picker__increase" type="button" aria-label="Increase minutes by 5" onClick={() => step('minute', 5)}><Icon name="chevron" size={19} /></button><input type="text" inputMode="numeric" role="spinbutton" aria-label="Minute" aria-valuemin={0} aria-valuemax={59} aria-valuenow={validMinute ? Number(minute) : undefined} aria-invalid={!validMinute || undefined} value={minute} maxLength={2} onFocus={event => event.currentTarget.select()} onChange={event => update('minute', event.target.value)} onBlur={() => {if (validMinute) setMinute(minute.padStart(2, '0'));}} onKeyDown={event => onKey(event, 'minute')} /><button type="button" aria-label="Decrease minutes by 5" onClick={() => step('minute', -5)}><Icon name="chevron" size={19} /></button></div></div>
    <div className="time-picker__period" role="group" aria-label="Time of day">{(['AM', 'PM'] as const).map(next => <button key={next} type="button" aria-pressed={period === next} onClick={() => {setPeriod(next); publish(hour, minute, next);}}>{next}</button>)}</div>
  </div>;
}
