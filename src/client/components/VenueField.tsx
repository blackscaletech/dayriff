import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import type { City, Venue, VenueSearchResult } from '../../shared/types';
import { api } from '../api';
import { SearchField } from './SearchField';
import { Icon } from './Icon';
import './VenueField.css';

type VenueOption = {id: string; name: string} & ({kind: 'city'; city: City} | {kind: 'venue'; venue: Venue});
const noOptions: VenueOption[] = [];
export function cityLabel(city: City): string { return [city.name, city.region].filter(Boolean).join(', '); }
function venueOption(venue: Venue): VenueOption { return {id: venue.id, name: venue.name, kind: 'venue', venue}; }
function optionsFor(result: VenueSearchResult): VenueOption[] {
  return [...result.cities.map(city => ({id: city.id, name: cityLabel(city), kind: 'city' as const, city})), ...result.venues.map(venueOption)].slice(0, 10);
}
function optionDetail(option: VenueOption): string {
  return option.kind === 'city' ? `${option.city.country || 'City'} · Find concert venues` : `${option.venue.city} · ${option.venue.address}`;
}

export function VenueField({value, onChange, city, onCityChange, initialVenues, inputRef, errorText}: {
  value: Venue | null; onChange: (venue: Venue | null) => void; city: City | null; onCityChange: (city: City | null) => void;
  initialVenues: Venue[]; inputRef: RefObject<HTMLInputElement | null>; errorText?: string;
}) {
  const [scoped, setScoped] = useState<{cityId: string; options: VenueOption[]; error: string} | null>(null);
  const initial = useMemo(() => initialVenues.map(venueOption), [initialVenues]);
  const selected = useMemo(() => value ? venueOption(value) : null, [value]);
  const search = useCallback(async (query: string, signal?: AbortSignal) => optionsFor(await api.venueSearch(query, city?.id, signal)), [city?.id]);
  useEffect(() => {
    if (!city) return;
    const controller = new AbortController();
    void api.venueSearch('', city.id, controller.signal).then(result => {
      if (!controller.signal.aborted) setScoped({cityId: city.id, options: optionsFor(result), error: ''});
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setScoped({cityId: city.id, options: [], error: error instanceof Error ? error.message : 'Venue search is unavailable. Try again.'});
    });
    return () => controller.abort();
  }, [city?.id]);
  const scopeReady = !city || scoped?.cityId === city.id;
  const options = city ? scopeReady ? scoped!.options : noOptions : initial;
  function select(option: VenueOption | null) {
    if (!option) { onChange(null); return; }
    if (option.kind === 'city') { onChange(null); onCityChange(option.city); }
    else onChange(option.venue);
  }
  return <div className="field venue-field">
    {city && <div className="venue-field__scope"><span><Icon name="pin" size={13} />{cityLabel(city)}</span><button className="icon-control" type="button" onClick={() => {onChange(null); onCityChange(null);}} aria-label="Change city"><Icon name="close" size={16} /></button></div>}
    <SearchField key={city?.id ?? 'all-cities'} label="Where’s the concert?" placeholder={city ? 'Search venues in this city' : 'Venue or city name'} value={selected} onChange={select}
      initialOptions={options} search={search} detail={optionDetail} icon="pin" inputRef={inputRef} autoFocus={Boolean(city)} loadingOptions={!scopeReady}
      helperText={!value && city ? 'Choose your concert venue below.' : undefined}
      emptyText={city ? 'Try the venue name, or choose another city.' : 'Try a venue name or a city and region.'}
      errorText={errorText || (city && scopeReady ? scoped?.error : undefined)}
      onQueryChange={() => {if (scoped?.error) setScoped(current => current ? {...current, error: ''} : current);}} />
  </div>;
}
