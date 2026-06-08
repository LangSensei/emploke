/**
 * Barrel re-export for the MSW fixture suite. Importers go through
 * here so handlers.ts stays decoupled from the per-resource fixture
 * file layout, and so the `artifactBodies` initialiser (which needs
 * top-level `await` to inline binary bodies) lives in exactly one
 * place.
 *
 * Tree-shaking note: this file (and the entire `mocks/` folder) is
 * only reachable through the dynamic import in `src/main.tsx`
 * guarded by `import.meta.env.VITE_USE_MOCKS`. With the flag unset
 * at build time, vite drops the entire subtree from the prod bundle
 * (the build-canary test in `test/no-mocks-in-prod-bundle.test.ts`
 * pins that guarantee).
 */

import sampleHtml from "./artifacts/sample.html?raw";
import sampleJson from "./artifacts/sample.json?raw";
import sampleMarkdown from "./artifacts/sample.md?raw";
import samplePngUrl from "./artifacts/sample.png?url";
import sampleText from "./artifacts/sample.txt?raw";

export { fixtureActivities } from "./activities.js";
export { fixtureAgents } from "./agents.js";
export { fixtureSchedules } from "./schedules.js";
export { fixtureSessions } from "./sessions.js";
export { fixtureTasks } from "./tasks.js";
export { fixtureWorkflowDags, fixtureWorkflows } from "./workflows.js";
export { fixtureActiveWorkspaceId, fixtureWorkspaces } from "./workspaces.js";

export interface ArtifactBody {
  contentType: string;
  body: string | Blob;
}

// Pre-fetch the PNG blob once at module init so the artifact handler
// can resolve synchronously. Vite returns a bundled URL for `?url`
// imports; `fetch(url)` reads the asset out of the dev server / built
// asset map. Top-level `await` is fine here because (a) tsconfig
// targets ES2022 and (b) this module is only imported under the
// dynamic `if (VITE_USE_MOCKS)` branch in main.tsx.
const samplePngBlob: Blob = await fetch(samplePngUrl).then((r) => r.blob());

/**
 * Bodies served by the artifact handler. Key is `<taskId>/<basename>` —
 * the basename matches what `success.artifacts` declares for each task
 * after `extractArtifacts()` strips the absolute-path prefix.
 */
export const artifactBodies = new Map<string, ArtifactBody>([
  ["single-html/sample.html", { contentType: "text/html", body: sampleHtml }],
  ["code-markdown/sample.md", { contentType: "text/markdown", body: sampleMarkdown }],
  ["code-markdown/sample.txt", { contentType: "text/plain", body: sampleText }],
  ["schedule-launched/sample.json", { contentType: "application/json", body: sampleJson }],
  ["running-multi-bin/sample.png", { contentType: "image/png", body: samplePngBlob }],
  ["running-multi-bin/sample.md", { contentType: "text/markdown", body: sampleMarkdown }],
]);
