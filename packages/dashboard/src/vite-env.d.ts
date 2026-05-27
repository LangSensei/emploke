/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Designer mode toggle. When set to "1" by `pnpm dev:mock` /
   * `dev:mock:e2e` (via `cross-env VITE_USE_MOCKS=1`), `main.tsx`
   * dynamically imports the MSW worker registration and starts it
   * before React mounts. Any other value (including unset) keeps the
   * prod bundle tree-shaken — the import call is statically
   * unreachable when the literal is not "1".
   */
  readonly VITE_USE_MOCKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
