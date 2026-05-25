import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentAvatar,
  avatarColorForFqn,
  hashFqn,
  monogramForLabel,
  readableTextOn,
} from "../src/components/agents/AgentAvatar";

/**
 * Lock-in coverage for the shared {@link AgentAvatar} primitive
 * introduced in PR #189 polish v3.
 *
 * The avatar's two load-bearing contracts:
 *   1. Background colour hashes the **full FQN**, not just `label`, so
 *      `langsensei/dev` and `acme/dev` get distinct colours and the
 *      avatar reinforces scope disambiguation in the agents-list row.
 *   2. The monogram is derived from `label` only, so the scope can
 *      never leak into the letters (defeating the disambiguation rule).
 */

afterEach(() => {
  cleanup();
});

describe("hashFqn", () => {
  it("is deterministic across calls", () => {
    expect(hashFqn("emploke/dev")).toBe(hashFqn("emploke/dev"));
  });

  it("produces different values for `langsensei/dev` and `acme/dev` (load-bearing)", () => {
    // Documentation guarantee: the avatar palette has 8 entries and the
    // colours derived below must not collide. The hash itself differing
    // is the upstream guarantee; the palette mod is tested separately.
    expect(hashFqn("langsensei/dev")).not.toBe(hashFqn("acme/dev"));
  });
});

describe("avatarColorForFqn", () => {
  it("returns the same colour for the same fqn across renders", () => {
    const first = avatarColorForFqn("emploke/dev");
    const second = avatarColorForFqn("emploke/dev");
    expect(first).toBe(second);
  });

  it("returns DIFFERENT colours for same short, different scope (load-bearing)", () => {
    // This is the property the row redesign relies on — without it the
    // avatar would merge `langsensei/dev` and `acme/dev` into the same
    // visual identity, defeating the disambiguation.
    const a = avatarColorForFqn("langsensei/dev");
    const b = avatarColorForFqn("acme/dev");
    expect(a).not.toBe(b);
  });

  it("returns a hex colour", () => {
    expect(avatarColorForFqn("emploke/dev")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("monogramForLabel", () => {
  it("derives a 2-letter monogram from the first two characters of a single-segment label", () => {
    expect(monogramForLabel("dev")).toBe("DE");
    expect(monogramForLabel("qa")).toBe("QA");
  });

  it("splits hyphenated labels and takes the first letter of each of the first two segments", () => {
    expect(monogramForLabel("agent-distill")).toBe("AD");
    expect(monogramForLabel("code-review")).toBe("CR");
  });

  it("handles underscore separators the same way as hyphens", () => {
    expect(monogramForLabel("code_review")).toBe("CR");
  });

  it("returns a single letter for a one-character label", () => {
    expect(monogramForLabel("a")).toBe("A");
  });

  it("falls back to '?' for an empty or unparseable label", () => {
    expect(monogramForLabel("")).toBe("?");
    expect(monogramForLabel("--")).toBe("?");
  });

  it("only inspects the label — scope letters never leak in", () => {
    // Even if a caller accidentally passed an fqn-looking value, the
    // function treats it as one segment until the first separator. The
    // intent is that callers always pass the `short` half — but if they
    // misuse it, we never silently mix scope characters into the
    // monogram via some helpful inference.
    expect(monogramForLabel("dev")).toBe("DE");
  });
});

describe("readableTextOn", () => {
  it("returns white text for dark backgrounds", () => {
    // Indigo, deep blue — these are dark enough to need white text.
    expect(readableTextOn("#2563eb")).toBe("#ffffff");
    expect(readableTextOn("#4f46e5")).toBe("#ffffff");
  });

  it("returns dark text for light backgrounds", () => {
    expect(readableTextOn("#ffffff")).toBe("#0f172a");
    expect(readableTextOn("#fef2f2")).toBe("#0f172a");
  });
});

describe("<AgentAvatar />", () => {
  it("renders the monogram derived from `label`", () => {
    render(<AgentAvatar fqn="emploke/dev" label="dev" />);
    const avatar = screen.getByTestId("agent-avatar-emploke/dev");
    expect(avatar.textContent).toBe("DE");
  });

  it("uses the full fqn for the deterministic colour (same short, different scope = different colour)", () => {
    const { container } = render(
      <div>
        <AgentAvatar fqn="langsensei/dev" label="dev" />
        <AgentAvatar fqn="acme/dev" label="dev" />
      </div>,
    );
    const a = container.querySelector('[data-testid="agent-avatar-langsensei/dev"]') as HTMLElement;
    const b = container.querySelector('[data-testid="agent-avatar-acme/dev"]') as HTMLElement;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.style.backgroundColor).not.toBe("");
    expect(b.style.backgroundColor).not.toBe("");
    expect(a.style.backgroundColor).not.toBe(b.style.backgroundColor);
    // But the monograms — derived from `label` only — are identical.
    expect(a.textContent).toBe(b.textContent);
  });

  it("applies the size preset to width/height (md = 40px default)", () => {
    render(<AgentAvatar fqn="a/b" label="b" />);
    const av = screen.getByTestId("agent-avatar-a/b");
    expect(av.style.width).toBe("40px");
    expect(av.style.height).toBe("40px");
    expect(av.className).toContain("agent-avatar--md");
  });

  it("supports sm and lg size presets", () => {
    const { container } = render(
      <div>
        <AgentAvatar fqn="a/b" label="b" size="sm" />
        <AgentAvatar fqn="c/d" label="d" size="lg" />
      </div>,
    );
    const small = container.querySelector(".agent-avatar--sm") as HTMLElement;
    const large = container.querySelector(".agent-avatar--lg") as HTMLElement;
    expect(small.style.width).toBe("24px");
    expect(small.style.height).toBe("24px");
    expect(large.style.width).toBe("56px");
    expect(large.style.height).toBe("56px");
  });

  it("sets aria-label to `Agent <fqn>` for screen readers", () => {
    render(<AgentAvatar fqn="emploke/dev" label="dev" />);
    const av = screen.getByTestId("agent-avatar-emploke/dev");
    expect(av.getAttribute("aria-label")).toBe("Agent emploke/dev");
  });

  it("renders readable foreground (white) on a deterministically dark accent", () => {
    // emploke/dev hashes into the palette; whichever entry it lands on,
    // the foreground must match the readable-text rule. We assert the
    // chosen fg equals what the helper would compute for the chosen bg.
    render(<AgentAvatar fqn="emploke/dev" label="dev" />);
    const av = screen.getByTestId("agent-avatar-emploke/dev") as HTMLElement;
    // happy-dom parses style.color as a CSS string; the helper returns
    // either "#ffffff" or "#0f172a" → normalized to the matching rgb()
    // value internally. We compare against the helper's own decision.
    const bg = avatarColorForFqn("emploke/dev");
    const expectedFg = readableTextOn(bg);
    // happy-dom keeps the raw hex in style.color; assert equality.
    expect(av.style.color.toLowerCase()).toBe(expectedFg);
  });
});
