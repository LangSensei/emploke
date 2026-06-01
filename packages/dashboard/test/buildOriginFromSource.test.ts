/**
 * Contract pin for `buildOriginFromSource`. Mirrors the CLI's
 * `buildInstallOrigin` guard in `packages/cli/src/commands/catalog.ts`:
 *  - `url` is pass-through (the server's `parseOrigin` picks the fetcher
 *     from the URL grammar).
 *  - `file` prepends `file:` if not already present.
 *  - `url` + a `file:` URI is rejected — the user almost certainly meant
 *     to pick `file`.
 */

import { describe, expect, it } from "vitest";
import { buildOriginFromSource } from "../src/api/catalog";

describe("buildOriginFromSource", () => {
  it("url provider passes through https URLs verbatim", () => {
    expect(
      buildOriginFromSource({
        provider: "url",
        location: "https://github.com/o/r/tree/main/x",
      }),
    ).toBe("https://github.com/o/r/tree/main/x");
  });

  it("file provider prepends file: to an absolute path", () => {
    expect(buildOriginFromSource({ provider: "file", location: "/abs/x" })).toBe("file:/abs/x");
  });

  it("file provider tolerates an already-prefixed file: URI", () => {
    expect(buildOriginFromSource({ provider: "file", location: "file:/abs/x" })).toBe(
      "file:/abs/x",
    );
  });

  it("url provider rejects a file: URI with a message naming URL and file:", () => {
    expect(() => buildOriginFromSource({ provider: "url", location: "file:/abs/x" })).toThrow(
      /URL.*file:/,
    );
  });
});
