import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentFqn } from "../../../src/components/agents/AgentFqn";

/**
 * Lock-in coverage for the shared {@link AgentFqn} two-tone primitive
 * introduced in PR #189 polish v3.
 *
 * Contract (from `.pilot/inbox/20260525-agents-row-redesign.md`):
 *   - Renders the full `scope/short` text in a single inline-flex span.
 *   - Both halves share the SAME font size and the SAME foreground colour.
 *   - Visual hierarchy comes from font-weight ONLY — scope normal, the
 *     `/` separator + short semibold. Scope MUST NOT be muted.
 */

afterEach(() => {
  cleanup();
});

describe("<AgentFqn />", () => {
  it("renders both the scope and the short halves, slash-separated", () => {
    render(<AgentFqn fqn="langsensei/dev" />);
    const root = screen.getByTestId("agent-fqn-langsensei/dev");
    // textContent concatenates all child text nodes — scope + "/" + short.
    expect(root.textContent).toBe("langsensei/dev");
  });

  it("renders the scope inside a class hook with NO 'muted' modifier (scope must stay full strength)", () => {
    const { container } = render(<AgentFqn fqn="emploke/dev" />);
    const scope = container.querySelector(".agent-fqn__scope") as HTMLElement;
    expect(scope).toBeTruthy();
    expect(scope.textContent).toBe("emploke");
    // No 'muted' class anywhere on the scope span — that's the whole
    // point of the disambiguation rule.
    expect(scope.className).not.toMatch(/muted/);
  });

  it("places the short half in a `__short` hook for the semibold rule", () => {
    const { container } = render(<AgentFqn fqn="emploke/dev" />);
    const short = container.querySelector(".agent-fqn__short") as HTMLElement;
    expect(short).toBeTruthy();
    expect(short.textContent).toBe("dev");
  });

  it("places the separator in its own span (so the bold weight matches the short half)", () => {
    const { container } = render(<AgentFqn fqn="emploke/dev" />);
    const sep = container.querySelector(".agent-fqn__sep") as HTMLElement;
    expect(sep).toBeTruthy();
    expect(sep.textContent).toBe("/");
  });

  it("exposes a title attribute with the full fqn (hover tooltip surfaces the truncated text)", () => {
    render(<AgentFqn fqn="really-long-scope-name/dev" />);
    const root = screen.getByTestId("agent-fqn-really-long-scope-name/dev");
    expect(root.getAttribute("title")).toBe("really-long-scope-name/dev");
  });

  it("applies the truncate-scope modifier class by default", () => {
    render(<AgentFqn fqn="emploke/dev" />);
    const root = screen.getByTestId("agent-fqn-emploke/dev");
    expect(root.className).toContain("agent-fqn--truncate-scope");
  });

  it("omits the truncate-scope modifier when truncateScope=false", () => {
    render(<AgentFqn fqn="emploke/dev" truncateScope={false} />);
    const root = screen.getByTestId("agent-fqn-emploke/dev");
    expect(root.className).not.toContain("agent-fqn--truncate-scope");
  });

  it('renders the wrapper as a `<div>` when `as="div"`', () => {
    const { container } = render(<AgentFqn fqn="emploke/dev" as="div" />);
    const root = container.querySelector("div.agent-fqn") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.tagName).toBe("DIV");
  });

  it("handles malformed fqns (no slash) by rendering the whole string in the short slot", () => {
    const { container } = render(<AgentFqn fqn="malformed" />);
    const root = container.querySelector(".agent-fqn") as HTMLElement;
    expect(root).toBeTruthy();
    const short = container.querySelector(".agent-fqn__short") as HTMLElement;
    expect(short.textContent).toBe("malformed");
  });
});
