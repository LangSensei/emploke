/**
 * Focused tests for the shared `RelativeTime` component. The
 * branching logic was consolidated here from two per-page row-time
 * wrappers (`TaskRelativeTime` / `WorkflowRelativeTime`) that no
 * longer exist; with only one home left for the dispatch, it needs
 * coverage in one place rather than via integration tests on either
 * consumer (where a regression would surface as a flaky text match
 * miles away from the cause).
 *
 * Covers all three branches of the prop-driven dispatch:
 *   - status === "running" && startedAt  → "running for X"
 *   - endedAt && startedAt               → "ran X · ended Y ago"
 *   - everything else                    → "created X ago"
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RelativeTime } from "../../../src/components/common/RelativeTime";

afterEach(() => cleanup());

describe("RelativeTime — running branch", () => {
  it("emits 'running for X' when status='running' and startedAt is set", () => {
    // startedAt 5m ago → formatDuration vs Date.now should land in
    // the m-bucket. Asserting on the prefix rather than the exact
    // numeric is intentional — the duration formatter has its own
    // tests; here we only care that this branch was selected.
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<RelativeTime status="running" startedAt={startedAt} createdAt={startedAt} />);
    expect(screen.getByText(/^running for /)).toBeTruthy();
  });

  it("falls through to the created-at branch when status='running' but startedAt is missing", () => {
    // No startedAt → the running branch's `&& startedAt` guard fails
    // and we end up on the third branch. Asserting on the literal
    // "created " prefix proves the dispatch, not a coincidence.
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    render(<RelativeTime status="running" createdAt={createdAt} />);
    expect(screen.getByText(/^created /)).toBeTruthy();
  });
});

describe("RelativeTime — terminal branch", () => {
  it("emits 'ran X · ended Y ago' when both startedAt and endedAt are set", () => {
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    render(
      <RelativeTime
        status="succeeded"
        startedAt={startedAt}
        endedAt={endedAt}
        createdAt={startedAt}
      />,
    );
    expect(screen.getByText(/^ran .* · ended /)).toBeTruthy();
  });

  it("uses endedAt for the title tooltip (forensic absolute timestamp)", () => {
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const endedAt = new Date(Date.now() - 60_000).toISOString();
    render(
      <RelativeTime
        status="succeeded"
        startedAt={startedAt}
        endedAt={endedAt}
        createdAt={startedAt}
      />,
    );
    // The terminal branch's wrapping <span> carries the absolute
    // formatted endedAt on `title`. We only verify the title was set
    // to *something* parseable from endedAt — the exact format comes
    // from formatAbsolute and is locale-dependent.
    const span = screen.getByText(/^ran /);
    expect(span.getAttribute("title")).toBeTruthy();
  });

  it("falls through to the created-at branch when endedAt is set but startedAt is missing", () => {
    // `endedAt && startedAt` guard short-circuits on the missing
    // startedAt; we end on the third branch.
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const endedAt = new Date(Date.now() - 10_000).toISOString();
    render(<RelativeTime status="succeeded" endedAt={endedAt} createdAt={createdAt} />);
    expect(screen.getByText(/^created /)).toBeTruthy();
  });
});

describe("RelativeTime — fallback branch", () => {
  it("emits 'created X ago' for the queued / unstarted shape", () => {
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    render(<RelativeTime status="queued" createdAt={createdAt} />);
    expect(screen.getByText(/^created /)).toBeTruthy();
  });

  it("emits 'created X ago' for a non-running, non-terminal status with no startedAt or endedAt", () => {
    // Any status string that isn't the literal "running" and lacks
    // the started/ended pair lands here — the helper deliberately
    // types `status: string` so it doesn't depend on either consumer's
    // status enum.
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    render(<RelativeTime status="custom-status-x" createdAt={createdAt} />);
    expect(screen.getByText(/^created /)).toBeTruthy();
  });
});

describe("RelativeTime — output shape (regression guards)", () => {
  it("renders the 'muted' class on the wrapping span so meta-row styling stays consistent", () => {
    // All three branches wrap in `<span class="muted">`. List-row meta
    // sentences depend on that class for the muted treatment; the
    // wrapper is the only DOM the consumer sees, so guard it here.
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const { container } = render(<RelativeTime status="queued" createdAt={createdAt} />);
    const span = container.querySelector("span.muted");
    expect(span).toBeTruthy();
  });
});
