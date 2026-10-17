import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { useSearch } from '../hooks/useSearch';
import { Icon } from './Icon';
import { FieldInput } from './FieldInput';
import './SearchField.css';

interface SearchItem { id: string; name: string }
interface Props<T extends SearchItem> {
  label: string;
  placeholder: string;
  value: T | null;
  onChange: (item: T | null) => void;
  initialOptions: T[];
  search: (query: string, signal?: AbortSignal) => Promise<T[]>;
  detail: (item: T) => string | undefined;
  icon: 'music' | 'pin';
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  helperText?: string;
  emptyText?: string;
  errorText?: string;
  autoFocus?: boolean;
  loadingOptions?: boolean;
  onQueryChange?: (query: string) => void;
}

function normalizedName(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLocaleLowerCase();
}

export function SearchField<T extends SearchItem>({ label, placeholder, value, onChange, initialOptions, search, detail, icon, disabled,
  inputRef, helperText, emptyText = 'Try a different name or add a city.', errorText, autoFocus, loadingOptions = false, onQueryChange }: Props<T>) {
  const id = useId();
  const [draft, setDraft] = useState(value?.name ?? '');
  const optionsRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const text = value?.name ?? draft;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const selected = !!value;
  const query = selected ? '' : text;
  const { results, loading: searching, error } = useSearch(query, initialOptions, search);
  const loading = searching || (query.trim().length < 2 && loadingOptions);
  const available = !loading && !error ? results : [];
  const visible = open && !disabled && available.length > 0;
  const highlighted = active >= 0 && active < available.length ? active : -1;
  const searchingText = icon === 'music' ? 'Finding artists…' : 'Finding places…';
  const empty = open && !selected && query.trim().length >= 2 && !loading && !error && !results.length;
  const feedback = errorText || (open && !disabled ? error || (empty ? emptyText : helperText) : helperText);
  const status = feedback || (open && !disabled && loading && !selected ? searchingText : undefined);

  useEffect(() => {
    if (visible && highlighted >= 0) optionsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlighted, visible]);

  function select(item: T) {
    onChange(item);
    setDraft(item.name);
    onQueryChange?.(item.name);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { setOpen(false); setActive(-1); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive(current => {
        if (!available.length) return -1;
        return event.key === 'ArrowDown' ? (current + 1) % available.length : (current <= 0 ? available.length - 1 : current - 1);
      });
      return;
    }
    if (event.key === 'Enter' && open) {
      if (highlighted >= 0) { event.preventDefault(); select(available[highlighted]); return; }
      if (!selected) {
        event.preventDefault();
        const exact = available.filter(item => normalizedName(item.name) === normalizedName(text));
        if (exact.length === 1) select(exact[0]);
      }
    }
  }

  return <div className={`field search-field${errorText ? ' search-field--invalid' : ''}`}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1); } }}>
    <label htmlFor={id}>{label}</label>
    <FieldInput icon={icon} className="search-field__input">
      <input ref={inputRef} id={id} role="combobox" aria-autocomplete="list" aria-expanded={visible} aria-busy={open && loading && !selected || undefined}
        aria-controls={visible ? `${id}-options` : undefined}
        aria-activedescendant={visible && highlighted >= 0 ? `${id}-option-${highlighted}` : undefined}
        aria-describedby={status ? `${id}-status` : undefined} aria-invalid={errorText ? true : undefined}
        autoComplete="off" autoCorrect="off" spellCheck={false} autoFocus={autoFocus} value={text} placeholder={placeholder} disabled={disabled} aria-required="true"
        onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        onChange={event => {
          const next = event.target.value;
          setDraft(next);
          if (!value || normalizedName(next) !== normalizedName(value.name)) onChange(null);
          onQueryChange?.(next);
          setOpen(true);
          setActive(-1);
        }} />
      {selected && <span className="search-field__selected" aria-label="Selected">✓</span>}
      {loading && open && !selected && <span className="search-field__loading" aria-hidden="true" />}
    </FieldInput>
    {status && <p id={`${id}-status`} className={`search-field__help${feedback ? '' : ' sr-only'}${errorText || error ? ' search-field__help--error' : ''}`}
      role={errorText ? 'alert' : 'status'}>{status}</p>}
    {visible && <div className="search-field__menu">
      <div ref={optionsRef} id={`${id}-options`} role="listbox" aria-label={`${label} suggestions`} className="search-field__options">
        {available.map((item, index) => <button type="button" role="option" id={`${id}-option-${index}`} key={item.id}
          aria-selected={index === highlighted} className="search-field__option" tabIndex={-1}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          }}
          onPointerUp={event => {
            const start = pointerStart.current;
            pointerStart.current = null;
            if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 10) select(item);
          }}
          onPointerCancel={() => { pointerStart.current = null; }}
          onMouseEnter={() => setActive(index)} onClick={event => { if (event.detail === 0) select(item); }}>
          <span className="search-field__option-copy"><span className="search-field__option-name">{item.name}</span>{detail(item) && <small>{detail(item)}</small>}</span>
          {value?.id === item.id ? <span className="search-field__option-check" aria-hidden="true">✓</span> : <Icon name="chevron" size={14} className="search-field__option-arrow" />}
        </button>)}
      </div>
    </div>}
  </div>;
}
