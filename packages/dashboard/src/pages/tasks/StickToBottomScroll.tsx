import { type ReactNode, useCallback, useLayoutEffect, useRef } from "react";

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
 *    tasks, jump to the bottom unconditionally so the latest events
 *    are visible right away. Also resets `stickToBottom = true` so
 *    follow-on poll updates keep tracking.
 * 2. **Follow effect** (keyed by `followKey`): each time the
 *    activity event count changes, if the user is currently pinned
 *    to the bottom, scroll the new content into view. If they've
 *    scrolled up, leave their viewport position alone — the new
 *    item appended below moves the scrollbar thumb up visually,
 *    but the content the user was reading stays in place.
 * 3. **Top-anchor effect** (keyed by `topAnchorKey`): when older
 *    history is prepended (the first item's seq decreases), the
 *    naive behavior is to keep `scrollTop` constant — but the
 *    content the user was reading shifts DOWN by the height of the
 *    prepended block. We compensate by adding `(newScrollHeight -
 *    oldScrollHeight)` to `scrollTop`, which preserves the user's
 *    reading position. Only runs when the user has scrolled away
 *    from the bottom (otherwise the follow effect handles it).
 *
 * `useLayoutEffect` (rather than `useEffect`) avoids the visible
 * one-frame jump that would otherwise show the un-scrolled state
 * before the autoscroll runs.
 *
 * The bottom-detection has a 4px tolerance for subpixel rounding
 * — without it, a freshly-appended item can take the user "out of
 * the bottom zone" by exactly the new item's height, breaking the
 * follow loop after a single update.
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
   * When this number decreases, we know a prepend happened and we
   * adjust `scrollTop` by the height delta. Optional: when omitted,
   * scroll-anchor behavior is disabled.
   */
  topAnchorKey?: string | number;
  children: ReactNode;
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

  // Reset on resetKey change — task switch jumps to bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger; the body intentionally only reads the ref.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
  }, [resetKey]);

  // Follow on followKey change — new events scroll into view if user
  // was pinned to the bottom; otherwise leave their position alone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: followKey is the trigger; the body intentionally only reads the ref.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [followKey]);

  // Top-anchor effect — preserve reading position on prepend.
  //
  // We track the previous topAnchorKey + scrollHeight in refs so the
  // next render can compute the delta. The first render initializes
  // the refs and skips adjustment (no prior measurement to compare
  // against). A "prepend" is detected when the topAnchorKey changes
  // AND, if both old and new are numbers, the new value is smaller
  // (older items have lower seq) — this rules out the "task switched
  // to a different first-item" case (handled by resetKey).
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
