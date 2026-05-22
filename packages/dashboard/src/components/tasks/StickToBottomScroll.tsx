import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Scroll container that follows the bottom of its content while the
 * user has scrolled to (or near) the bottom — matches how chat apps
 * (Slack, Cursor agent, browser DevTools console) keep the latest
 * line visible during live activity, without yanking the user's
 * position when they've scrolled up to read history.
 *
 * Three effects:
 *
 * 1. **Reset effect** (keyed by `resetKey`): when the user switches
 *    tasks, jump to the bottom unconditionally.
 * 2. **Follow effect** (keyed by `followKey`): each time a new tail
 *    event arrives, if the user is currently pinned to the bottom,
 *    scroll the new content into view. Otherwise leave their viewport
 *    position alone.
 * 3. **Top-anchor effect** (keyed by `topAnchorKey`): when older
 *    history is prepended (the first item's seq decreases), the
 *    naive behavior is to keep `scrollTop` constant — but the content
 *    the user was reading shifts DOWN by the height of the prepended
 *    block. We compensate by adding `(newScrollHeight - oldScrollHeight)`
 *    to `scrollTop`. Only runs when the user has scrolled away from
 *    the bottom.
 *
 * `useLayoutEffect` avoids the visible one-frame jump that would
 * otherwise show the un-scrolled state before the autoscroll runs.
 *
 * The bottom-detection has a 4px tolerance for subpixel rounding.
 */
export function StickToBottomScroll({
  className,
  resetKey,
  followKey,
  topAnchorKey,
  children,
}: {
  className?: string;
  /** Changes → unconditional jump to bottom (e.g. task switch). */
  resetKey: string | number;
  /** Changes → scroll to bottom only if user was at bottom. */
  followKey: string | number;
  /**
   * Changes → preserve reading position when content was prepended.
   * Should be the seq (or unique key) of the FIRST item in the list.
   */
  topAnchorKey?: string | number;
  children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const isAtBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isAtBottom(el);
  }, [isAtBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger; the body intentionally only reads the ref.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
  }, [resetKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: followKey is the trigger; the body intentionally only reads the ref.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [followKey]);

  const prevScrollHeightRef = useRef(0);
  const prevTopAnchorRef = useRef<string | number | undefined>(topAnchorKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: topAnchorKey is the trigger; refs are intentionally read inside.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prevKey = prevTopAnchorRef.current;
    const prevHeight = prevScrollHeightRef.current;
    if (
      topAnchorKey !== undefined &&
      prevKey !== undefined &&
      prevKey !== topAnchorKey &&
      typeof prevKey === "number" &&
      typeof topAnchorKey === "number" &&
      topAnchorKey < prevKey &&
      prevHeight > 0 &&
      !stickToBottomRef.current
    ) {
      const delta = el.scrollHeight - prevHeight;
      if (delta > 0) {
        el.scrollTop += delta;
      }
    }
    prevTopAnchorRef.current = topAnchorKey;
    prevScrollHeightRef.current = el.scrollHeight;
  }, [topAnchorKey]);

  return (
    <div ref={scrollRef} className={className} onScroll={onScroll}>
      {children}
    </div>
  );
}
