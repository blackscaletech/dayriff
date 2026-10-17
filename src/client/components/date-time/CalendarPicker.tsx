import {useEffect, useId, useRef, useState, type KeyboardEvent} from 'react';
import {Icon} from '../Icon';
import {addDays, dateInRange, fullDateLabel, monthDays, monthLabel, shiftMonth, todayValue, weekday} from './values';
import './CalendarPicker.css';

export function CalendarPicker({value, onChange, min, max}: {value: string; onChange: (value: string) => void; min?: string; max?: string}) {
  const [month, setMonth] = useState(`${value.slice(0, 7)}-01`);
  const [focused, setFocused] = useState(value);
  const buttons = useRef(new Map<string, HTMLButtonElement>()), focusAfterUpdate = useRef(false), heading = useId();
  const today = todayValue(), cells = monthDays(month);
  useEffect(() => {
    const frame = requestAnimationFrame(() => buttons.current.get(value)?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {if (focusAfterUpdate.current) {buttons.current.get(focused)?.focus(); focusAfterUpdate.current = false;}}, [focused, month]);
  function moveFocus(next: string | undefined) {
    if (!next || !dateInRange(next, min, max)) return;
    focusAfterUpdate.current = true;
    setFocused(next);
    setMonth(`${next.slice(0, 7)}-01`);
  }
  function choose(next: string) {onChange(next); moveFocus(next);}
  function onDayKey(event: KeyboardEvent<HTMLButtonElement>, day: string) {
    const amount = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7}[event.key];
    let next: string | undefined;
    if (amount !== undefined) next = addDays(day, amount);
    else if (event.key === 'Home') next = addDays(day, -weekday(day));
    else if (event.key === 'End') next = addDays(day, 6 - weekday(day));
    else if (event.key === 'PageUp') next = shiftMonth(day, event.shiftKey ? -12 : -1);
    else if (event.key === 'PageDown') next = shiftMonth(day, event.shiftKey ? 12 : 1);
    else return;
    event.preventDefault();
    moveFocus(next);
  }
  function canNavigate(direction: number) {
    const next = shiftMonth(month, direction);
    if (!next) return false;
    return monthDays(next).some(day => day.inMonth && day.value && dateInRange(day.value, min, max));
  }
  function navigate(direction: number) {
    const next = shiftMonth(month, direction);
    if (!next) return;
    setMonth(next);
    const first = monthDays(next).find(day => day.inMonth && day.value && dateInRange(day.value, min, max));
    if (first?.value) setFocused(first.value);
  }
  return <div className="calendar-picker">
    <div className="calendar-picker__navigation"><h3 id={heading} aria-live="polite">{monthLabel(month)}</h3><div><button className="icon-control calendar-picker__previous" type="button" aria-label="Previous month" disabled={!canNavigate(-1)} onClick={() => navigate(-1)}><Icon name="chevron" size={18} /></button><button className="icon-control calendar-picker__next" type="button" aria-label="Next month" disabled={!canNavigate(1)} onClick={() => navigate(1)}><Icon name="chevron" size={18} /></button></div></div>
    <div className="calendar-picker__weekdays" aria-hidden="true">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="calendar-picker__days" role="group" aria-labelledby={heading}>{cells.map((cell, index) => cell.value ? <button key={cell.value} ref={element => {if (element) buttons.current.set(cell.value!, element); else buttons.current.delete(cell.value!);}} className={`calendar-picker__day${cell.inMonth ? '' : ' calendar-picker__day--outside'}${cell.value === value ? ' calendar-picker__day--selected' : ''}`} type="button" aria-label={fullDateLabel(cell.value)} aria-pressed={cell.value === value} aria-current={cell.value === today ? 'date' : undefined} disabled={!dateInRange(cell.value, min, max)} tabIndex={cell.value === focused ? 0 : -1} onFocus={() => setFocused(cell.value!)} onKeyDown={event => onDayKey(event, cell.value!)} onClick={() => choose(cell.value!)}><span>{cell.day}</span></button> : <span key={`empty-${index}`} />)}</div>
    <div className="calendar-picker__today"><button className="button button--glass button--small" type="button" disabled={!dateInRange(today, min, max)} onClick={() => choose(today)}>Today</button></div>
  </div>;
}
