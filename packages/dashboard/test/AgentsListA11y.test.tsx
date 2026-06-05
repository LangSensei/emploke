import type { AgentEntry } from "@emploke/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogData, ServerConfig, SessionView, TaskRecord } from "../src/api";
import {
  WorkspaceShellContext,
  type WorkspaceShellContextValue,
} from "../src/components/WorkspaceShellContext";
import { AgentsListPage } from "../src/pages/Runtime/AgentsListPage";

/**
 * Coverage for the issue #317 a11y row-listbox migration. Mirrors the
 * spec PR #316 used for Tasks + Schedules, adapted to the simpler shape
 * of the Agents row (no per-row action menu — kebab was removed in
 * PR #189 polish v3, so each row has exactly ONE top-level button).
 *
 * The previous shape was a fake listbox: `<ul role="listbox">` +
 * `<li role="option" tabIndex={0} onClick onKeyDown aria-selected>`,
 * which advertised listbox keyboard semantics (arrow nav, Home/End,
 * `aria-activedescendant`, roving tabindex) that the code never
 * implemented. The new shape is a presentational `<ul role="list">` +
 * `<li>` with a real `<button class="agents-list__item-select">` child
 * carrying `aria-current`, `aria-labelledby` (→ fqn) and
 * `aria-describedby` (→ version + status + activity), so the only
 * keyboard contract on the row is the native button one (Enter/Space
 * activates).
 *
 * Why a dedicated file: keeps the migration's lock-in tests grouped so
 * a regression that rolls back to the listbox shape doesn't have to be
 * caught by reading scattered assertions across the existing
 * AgentsListBlockH / AgentsPageSplitLayout files. Mirrors the dedicated
 * `task-list-item-a11y` style assertions PR #316 introduced for Tasks.
 */

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    listTasks: vi.fn(),
    listSessions: vi.fn(),
  };
});

import * as api from "../src/api";

const mockListTasks = api.listTasks as unknown as ReturnType<typeof vi.fn>;
const mockListSessions = api.listSessions as unknown as ReturnType<typeof vi.fn>;

function makeAgent(fqn: string, version = "1.2.3"): AgentEntry {
  const [scope, short] = fqn.split("/");
  return {
    agent: { fqn, scope, short, version },
    status: "ready",
  } as unknown as AgentEntry;
}

function makeTask(agent: string, status: TaskRecord["status"], id: string): TaskRecord {
  return {
    id,
    agent,
    status,
    brief: "",
    details: "",
    origin: "standalone",
    metadata: {},
    createdAt: "2026-05-23T00:00:00Z",
  } as unknown as TaskRecord;
}

function shellValue(agents: AgentEntry[]): WorkspaceShellContextValue {
  const data: CatalogData = {
    overview: null,
    skills: [],
    agents,
    mcps: [],
  } as unknown as CatalogData;
  return {
    wsId: "ws-1",
    workspaces: [],
    data,
    config: { pathSeparator: "/" } as unknown as ServerConfig,
    refreshData: async () => {},
  };
}

function renderList(agents: AgentEntry[], initialPath = "/workspaces/ws-1/runtime/agents") {
  return render(
    <WorkspaceShellContext.Provider value={shellValue(agents)}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/workspaces/:wsId/runtime/agents" element={<AgentsListPage />} />
        </Routes>
      </MemoryRouter>
    </WorkspaceShellContext.Provider>,
  );
}

beforeEach(() => {
  mockListTasks.mockReset();
  mockListSessions.mockReset();
  mockListTasks.mockResolvedValue([]);
  mockListSessions.mockResolvedValue([] as SessionView[]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("issue #317 — Agents row a11y migration", () => {
  it("wrapper <ul> is a real list (role='list' + matching tag) with the visible label", async () => {
    // Pre-migration: the <ul> carried role='listbox' to back the
    // fake-listbox shape on the row children. Post-migration the <ul>
    // is an explicit role='list' — explicit because Safari + VoiceOver
    // strip the implicit listitem role from <li> children when the
    // <ul> has `list-style: none` (the .agents-list class sets that),
    // and without explicit `role='list'` AT users on macOS/iOS lose
    // list semantics entirely (no "list, N items" announcement, no
    // aria-posinset cues). The explicit role is a no-op in
    // Chrome/Firefox/Edge but a load-bearing fix on Safari.
    renderList([makeAgent("emploke/alpha"), makeAgent("emploke/beta")]);
    const list = await screen.findByRole("list", { name: /installed agents/i });
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("role")).toBe("list");
    // The legacy listbox role is gone — assert it doesn't sneak back.
    expect(screen.queryByRole("listbox", { name: /installed agents/i })).toBeNull();
  });

  it("each row is a presentational <li> (no role, no tabindex, no aria-selected, no onClick)", async () => {
    renderList([makeAgent("emploke/alpha")]);
    const row = await screen.findByTestId("agent-row-emploke/alpha");
    expect(row.tagName).toBe("LI");
    // No role on the <li> — descendant text inside the <ul role='list'>
    // resolves to listitem implicitly (and explicit if Safari strips
    // the implicit one — see the wrapper assertion above).
    expect(row.getAttribute("role")).toBeNull();
    // No tabindex — Tab moves to the inner <button>, not the <li>.
    expect(row.getAttribute("tabindex")).toBeNull();
    // No aria-selected — the listbox-only attribute is gone.
    expect(row.getAttribute("aria-selected")).toBeNull();
    // No onClick on the <li> — React attaches an onclick property
    // when the prop is set, so a null `onclick` confirms no handler
    // was installed at the row level (clicks live on the button).
    expect(row.onclick).toBeNull();
  });

  it("row carries exactly ONE top-level <button> (no per-row menu, no nested buttons)", async () => {
    // AgentRow has NO per-row action menu — the kebab was removed in
    // PR #189 polish v3. So each row produces exactly one button (the
    // row-select). Defensive: AgentAvatar / AgentFqn / AgentStatusPill
    // all render <span>s only, never a nested <button>.
    renderList([makeAgent("emploke/alpha")]);
    const row = await screen.findByTestId("agent-row-emploke/alpha");
    const buttons = row.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("data-testid")).toBe("agent-row-select-emploke/alpha");
    // No nested buttons (HTML spec disallows it; browsers fix it by
    // hoisting the inner button out of the DOM — which would silently
    // change the click target and break the keyboard contract).
    expect(row.querySelector("button button")).toBeNull();
  });

  it("the select button is a real native <button type='button'> with onClick that selects the row", async () => {
    // The Enter/Space contract on the row is the native-button
    // contract: real <button> handles Enter/Space activation. We don't
    // try to synthesize keydown→click in jsdom (which doesn't model
    // that link); we assert the shape so the platform guarantee is
    // load-bearing.
    renderList([makeAgent("emploke/alpha"), makeAgent("emploke/beta")]);
    await waitFor(() => {
      expect(screen.getByTestId("agent-row-select-emploke/beta")).toBeTruthy();
    });
    const betaSelect = screen.getByTestId("agent-row-select-emploke/beta") as HTMLButtonElement;
    expect(betaSelect.tagName).toBe("BUTTON");
    expect(betaSelect.getAttribute("type")).toBe("button");

    // Clicking it surfaces beta in the detail pane via URL state.
    act(() => {
      fireEvent.click(betaSelect);
    });
    await waitFor(() => {
      const pane = screen.getByTestId("agent-detail-pane");
      expect(pane.getAttribute("data-agent-fqn")).toBe("emploke/beta");
    });
  });

  it("aria-current on the select button toggles correctly (true when selected, absent when not)", async () => {
    // Crucially aria-current must be ABSENT — not "false" — when the
    // row isn't selected; only the truthy value carries meaning, and
    // `aria-current="false"` is treated by some SRs as if it were
    // unset, but pinning the absence keeps the contract explicit.
    renderList(
      [makeAgent("emploke/alpha"), makeAgent("emploke/beta")],
      "/workspaces/ws-1/runtime/agents?selected=emploke%2Falpha",
    );

    const alphaSelect = await screen.findByTestId("agent-row-select-emploke/alpha");
    const betaSelect = screen.getByTestId("agent-row-select-emploke/beta");

    expect(alphaSelect.getAttribute("aria-current")).toBe("true");
    expect(betaSelect.getAttribute("aria-current")).toBeNull();

    // Click beta — aria-current swaps.
    act(() => {
      fireEvent.click(betaSelect);
    });
    await waitFor(() => {
      expect(betaSelect.getAttribute("aria-current")).toBe("true");
    });
    expect(alphaSelect.getAttribute("aria-current")).toBeNull();
  });

  it("aria-labelledby resolves to the agent's FQN; aria-describedby chain resolves to version + status + activity", async () => {
    // `aria-labelledby` REPLACES descendant-text concatenation in the
    // accessibility tree — so if we wired only labelledby, the SR
    // would hear ONLY the FQN on focus and lose version/status/activity
    // entirely. The describedby chain (versionId statusId activityId in
    // DOM order) restores the descriptive metadata as the button's
    // accessible description. Both must be wired.
    const agent = makeAgent("emploke/alpha", "1.2.3");
    mockListTasks.mockResolvedValue([makeTask("emploke/alpha", "running", "t-r1")]);
    renderList([agent]);

    const select = (await screen.findByTestId(
      "agent-row-select-emploke/alpha",
    )) as HTMLButtonElement;

    // labelledby → headline span around <AgentFqn>. The text content
    // of that span is the FQN ("emploke/alpha" with the visual
    // scope/short split via AgentFqn).
    const labelledById = select.getAttribute("aria-labelledby");
    expect(labelledById).toBeTruthy();
    const labelEl = document.getElementById(labelledById ?? "");
    expect(labelEl).toBeTruthy();
    // AgentFqn renders three spans (scope + sep + short) inside a
    // wrapping span; the wrapping span's textContent collapses them
    // into the fqn.
    expect(labelEl?.textContent).toBe("emploke/alpha");

    // describedby → versionId statusId activityId, IN DOM ORDER.
    const describedByIds = (select.getAttribute("aria-describedby") ?? "").split(/\s+/);
    expect(describedByIds.length).toBe(3);
    const describingText = describedByIds
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(describingText).toContain("v1.2.3");
    expect(describingText).toMatch(/Running/);
    // After the tasks fetch resolves, activity should say "1 running".
    await waitFor(() => {
      const refreshed = describedByIds
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(refreshed).toMatch(/1 running/);
    });
  });

  it("each <li> carries aria-posinset (1-based) and aria-setsize matching the visible row count", async () => {
    // Without these, AT users on Safari/VoiceOver hear row content
    // with no positional cues ("row 3 of 7"). The values are computed
    // from the visible filteredViews array — 1-based index and the
    // array length — so they reflect the post-filter set, NOT the
    // raw agent catalog.
    const agents = [
      makeAgent("emploke/alpha"),
      makeAgent("emploke/beta"),
      makeAgent("emploke/charlie"),
    ];
    renderList(agents);

    await waitFor(() => {
      expect(screen.getByTestId("agent-row-emploke/alpha")).toBeTruthy();
    });

    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('li[data-testid^="agent-row-"]'),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(rows[0]?.getAttribute("aria-setsize")).toBe("3");
    expect(rows[1]?.getAttribute("aria-posinset")).toBe("2");
    expect(rows[1]?.getAttribute("aria-setsize")).toBe("3");
    expect(rows[2]?.getAttribute("aria-posinset")).toBe("3");
    expect(rows[2]?.getAttribute("aria-setsize")).toBe("3");
  });

  it("tab order — exactly N stops within the list (one per row, NOT 2N like Tasks/Schedules)", async () => {
    // Tasks + Schedules rows have 2 buttons each post-#316: the
    // row-select + the ⋯ action menu trigger. Agents rows have NO
    // menu (PR #189 polish v3 removed it), so the list contains
    // exactly N tab stops — one per row. Pinning that contract
    // prevents a future regression that re-adds the menu without
    // updating the keyboard-flow expectation.
    const agents = [
      makeAgent("emploke/alpha"),
      makeAgent("emploke/beta"),
      makeAgent("emploke/charlie"),
    ];
    renderList(agents);

    const list = await screen.findByRole("list", { name: /installed agents/i });
    const buttons = within(list).getAllByRole("button");
    expect(buttons).toHaveLength(agents.length);
    // Each button is the row-select (data-testid hook makes the
    // mapping obvious; serves double duty as a smoke test that the
    // testid naming convention is consistent across rows).
    const testids = buttons.map((b) => b.getAttribute("data-testid"));
    expect(testids).toEqual([
      "agent-row-select-emploke/alpha",
      "agent-row-select-emploke/beta",
      "agent-row-select-emploke/charlie",
    ]);
  });

  it("the AgentAvatar inside the select button is decorative (wrapped with aria-hidden)", async () => {
    // AgentAvatar carries its own role='img' + aria-label so it works
    // as a standalone primitive elsewhere (the detail pane header
    // mounts the same component, where the label IS the accessible
    // affordance). Inside the row's select button it would otherwise
    // fragment the button's accessible name into "Agent emploke/alpha
    // emploke/alpha" (the avatar's label + the labelledby target's
    // text). We mark the wrapping span aria-hidden so the avatar is
    // pruned from the a11y tree under the button, keeping the
    // button's accessible name a clean "emploke/alpha".
    renderList([makeAgent("emploke/alpha")]);
    const select = await screen.findByTestId("agent-row-select-emploke/alpha");
    const avatar = select.querySelector('[data-testid="agent-avatar-emploke/alpha"]');
    expect(avatar).toBeTruthy();
    // The wrapping span around AgentAvatar carries aria-hidden.
    const wrapper = avatar?.parentElement;
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
  });
});
