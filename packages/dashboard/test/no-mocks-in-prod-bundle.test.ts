import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Resolve to packages/dashboard/dist regardless of the cwd vitest was
// invoked from (workspace root vs the dashboard package).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST = path.resolve(__dirname, "../dist");

/**
 * Build canary — pins the contract from issue #212 PR-A that the
 * mocks/ + fixtures/ + MSW devDep do NOT leak into the production
 * bundle. The dynamic `import.meta.env.VITE_USE_MOCKS === "1"` check
 * in `src/main.tsx` is the seam that lets vite tree-shake the whole
 * subtree out when the flag is unset at build time.
 *
 * Runs after `pnpm -F @emploke/dashboard build`. The test
 * self-skips (warn + early return) when `dist/` is absent so the
 * fast inner-loop `pnpm test` stays fast — CI runs `build && test`
 * sequentially so the bundle is always present when this matters.
 */
const distExists = (() => {
  try {
    return statSync(DIST).isDirectory();
  } catch {
    return false;
  }
})();

const distFiles: string[] = distExists ? walkBundle(DIST) : [];

function walkBundle(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkBundle(p));
    } else if (p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".html")) {
      out.push(p);
    }
  }
  return out;
}

describe("prod bundle excludes mocks", () => {
  if (!distExists) {
    it.skip("dist/ absent — run `pnpm -F @emploke/dashboard build` to enable this canary", () => {
      // Intentionally empty; the it.skip above documents the skip
      // reason in vitest output. CI runs build before test so this
      // branch is never taken there.
    });
    return;
  }

  it("dist/ contains at least one bundled .js asset", () => {
    expect(distFiles.some((f) => f.endsWith(".js"))).toBe(true);
  });

  it.each([
    ["setupWorker", "MSW worker registration leaked into bundle"],
    ["mockServiceWorker", "mockServiceWorker reference leaked into bundle"],
    ["fixtureTasks", "hand-authored task fixture identifier leaked into bundle"],
    ["fixtureAgents", "hand-authored agent fixture identifier leaked into bundle"],
    ["fixtureSchedules", "hand-authored schedule fixture identifier leaked into bundle"],
    ["fixtureSessions", "hand-authored session fixture identifier leaked into bundle"],
    ["fixtureWorkspaces", "hand-authored workspace fixture identifier leaked into bundle"],
    ["artifactBodies", "artifact-body map leaked into bundle"],
  ])("does not include %s anywhere in dist/*.{js,css,html}", (needle, _reason) => {
    const offenders: string[] = [];
    for (const f of distFiles) {
      const body = readFileSync(f, "utf8");
      if (body.includes(needle)) offenders.push(path.relative(DIST, f));
    }
    expect(offenders).toEqual([]);
  });
});
