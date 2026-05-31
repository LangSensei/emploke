import { type RefObject, useEffect, useRef } from "react";

/**
 * Returns a stable `RefObject<boolean>` that tracks whether the
 * component is mounted. Use the returned ref to guard post-`await`
 * `setState` calls:
 *
 * ```ts
 * const mounted = useMounted();
 * await fetchSomething();
 * if (!mounted.current) return;
 * setData(result);
 * ```
 *
 * React 18 StrictMode invokes `useEffect` with mount → cleanup → mount
 * in development, which can leave a previously-initialised mountedRef
 * in a `false` state when the second mount runs. We re-initialise to
 * `true` inside the effect body so the ref is correctly `true` for the
 * lifetime of every mount; otherwise post-await `setState` calls
 * (e.g. `setBusy(false)`) silently no-op and the UI gets stuck
 * (e.g. "Creating…" forever).
 *
 * A reviewer who has not read the React 18 StrictMode docs might try to
 * "simplify" this hook by removing the in-effect `mountedRef.current = true`
 * line on the grounds that `useRef(true)` already initialises it. That
 * simplification is wrong; the line is load-bearing for StrictMode.
 */
export function useMounted(): RefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}
