import { cleanup, render } from "@testing-library/react";
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

  it("re-initialises to true if the same ref is observed across two mount cycles", () => {
    // Lock-in for the StrictMode-safe form: a fresh mount of the same
    // component class invokes the effect again, which must set current
    // back to true even if a prior cleanup left it false. Tests the
    // exact bug the in-effect re-init defends against.
    let captured: { current: boolean | null } | null = null;
    const first = render(<Probe capture={(ref) => (captured = ref)} />);
    first.unmount();
    expect(captured?.current).toBe(false);
    render(<Probe capture={(ref) => (captured = ref)} />);
    expect(captured?.current).toBe(true);
  });
});
