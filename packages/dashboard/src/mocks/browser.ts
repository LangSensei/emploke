import { setupWorker } from "msw/browser";

import { handlers } from "./handlers.js";

/**
 * MSW Service Worker instance for designer mode. Imported dynamically
 * from `src/main.tsx` behind the `VITE_USE_MOCKS` flag so vite can
 * tree-shake the entire `mocks/` subtree out of the production bundle
 * (canary test in `test/no-mocks-in-prod-bundle.test.ts` pins it).
 */
export const worker = setupWorker(...handlers);
