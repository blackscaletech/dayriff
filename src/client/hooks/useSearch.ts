import { useEffect, useState } from 'react';

type Search<T> = (query: string, signal?: AbortSignal) => Promise<T[]>;
interface SearchState<T> { query: string; search: Search<T>; results: T[]; loading: boolean; error: string }

export function useSearch<T>(query: string, initialOptions: T[], search: Search<T>) {
  const normalized = query.trim();
  const [state, setState] = useState<SearchState<T>>({ query: '', search, results: [], loading: false, error: '' });

  useEffect(() => {
    if (normalized.length < 2) return;
    const controller = new AbortController();
    setState({ query: normalized, search, results: [], loading: true, error: '' });
    const timer = window.setTimeout(() => {
      void search(normalized, controller.signal).then(results => {
        if (!controller.signal.aborted) setState({ query: normalized, search, results, loading: false, error: '' });
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setState({ query: normalized, search, results: [], loading: false,
          error: reason instanceof Error ? reason.message : 'Search is unavailable. Please try again.' });
      });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [normalized, search]);

  if (normalized.length < 2) return { results: initialOptions, loading: false, error: '' };
  if (state.query !== normalized || state.search !== search) return { results: [] as T[], loading: true, error: '' };
  return { results: state.results, loading: state.loading, error: state.error };
}
