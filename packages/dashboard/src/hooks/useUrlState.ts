import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

/**
 * Read + guarded-write pair for a single URL search-params value.
 *
 * Sentinel `defaultValue` semantics:
 *   - When the URL omits the key, reads as `defaultValue`.
 *   - When the writer is called with `defaultValue`, the key is
 *     **removed** instead of stored — keeps URLs canonical (no
 *     `?range=7d` cluttering the bar when 7d is also the default).
 *
 * Loop guard: setters compare the incoming value against the current
 * URL value and bail out early when they match. Without this, an
 * effect that calls `setValue(value)` would re-render → re-fire the
 * effect → re-call `setValue(value)` forever (React-Router v6
 * StrictMode reproducibly triggers this in dev when filters are
 * derived during render).
 *
 * The setter rebuilds the new search string from `location.search`
 * (which it re-reads each invocation through the useCallback dep
 * array), then calls `navigate(...)` with an absolute path-and-search
 * string so the router commits the change without going through
 * `useSearchParams`'s captured-snapshot path. The page is responsible
 * for not chaining stale-state writes that would clobber a sibling
 * URL-clear — see `TasksPage`'s `effectiveSelectedId` for the
 * derived-during-render alternative to effect-driven URL writes.
 *
 * `replace: true` is the default history mode — typing into the
 * search box should not create one history entry per keystroke.
 *
 * Phase 1.5 §4.5 / §4.6 / Block G — Sessions and Tasks pages use
 * this to keep filters refresh-stable and shareable.
 */
export function useUrlSearchValue(
  key: string,
  defaultValue: string,
): readonly [string, (next: string, opts?: { historyPush?: boolean }) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const value = params.get(key) ?? defaultValue;

  const setValue = useCallback(
    (next: string, opts?: { historyPush?: boolean }) => {
      const current = new URLSearchParams(location.search);
      const currentValue = current.get(key) ?? defaultValue;
      if (currentValue === next) return;
      if (next === defaultValue) current.delete(key);
      else current.set(key, next);
      const search = current.toString();
      navigate(`${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`, {
        replace: !opts?.historyPush,
      });
    },
    [navigate, key, defaultValue, location.pathname, location.search, location.hash],
  );
  return [value, setValue] as const;
}

/**
 * "Clear filters" handler — drops the entire query string while
 * keeping the user on the current path. Used by the Clear-filters
 * button on Sessions and Tasks pages.
 *
 * Uses `useSearchParams().setSearchParams` rather than `navigate(...)`
 * directly: the former routes through react-router's own params-
 * mutation path which (unlike `navigate(pathname, {replace})` in v7)
 * reliably triggers a re-render even when the resolved pathname
 * matches the current one.
 */
export function useClearUrlFilters(): () => void {
  const [, setSearchParams] = useSearchParams();
  return useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [setSearchParams]);
}
