import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useMounted } from "../../src/hooks/useMounted";

afterEach(() => {
  cleanup();
});

interface ProbeProps {
  capture: (ref: { current: boolean | null }) => void;
}

function Probe({ capture }: ProbeProps) {
  const mounted = useMounted();
  capture(mounted);
  return null;
}

describe("useMounted", () => {
  it("returns a ref that is true while mounted", () => {
    let captured: { current: boolean | null } | null = null;
    render(<Probe capture={(ref) => (captured = ref)} />);
    expect(captured).not.toBeNull();
    expect(captured?.current).toBe(true);
  });

  it("flips the ref to false after unmount so post-await guards can early-return", () => {
    let captured: { current: boolean | null } | null = null;
    const { unmount } = render(<Probe capture={(ref) => (captured = ref)} />);
    expect(captured?.current).toBe(true);
    unmount();
    expect(captured?.current).toBe(false);
  });

  it("re-initialises to true under React StrictMode's mount→cleanup→mount double-invoke", () => {
    // Load-bearing guard for the in-effect `mountedRef.current = true`
    // line in `useMounted.ts`. React's dev-mode StrictMode runs the
    // useEffect cycle mount → cleanup → mount on the SAME component
    // instance, reusing the same ref object across the cycle. Without
    // the in-effect re-init, the first pass's cleanup leaves the ref
    // at false and the second mount never resets it, breaking every
    // post-await `if (!mounted.current) return;` guard in the app.
    //
    // Two independent render() calls cannot reproduce this (each gets
    // a freshly-initialised useRef(true) ref). Wrapping the probe in
    // <StrictMode> is what actually exercises the dev double-invoke,
    // so this assertion fails iff the load-bearing line is removed.
    let captured: { current: boolean | null } | null = null;
    render(
      <StrictMode>
        <Probe capture={(ref) => (captured = ref)} />
      </StrictMode>,
    );
    expect(captured).not.toBeNull();
    expect(captured?.current).toBe(true);
  });
});
