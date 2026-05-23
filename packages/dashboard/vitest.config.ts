import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the dashboard package — distinct from `vite.config.ts`
 * so the dev/build server config isn't loaded for unit tests.
 *
 * `happy-dom` is the lightweight DOM env (vs jsdom) — sufficient for
 * the React Testing Library snapshots used by the viewer/ArtifactsTab
 * suites.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
