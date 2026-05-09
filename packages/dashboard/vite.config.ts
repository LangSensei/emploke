import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev:
//   - Vite hosts the dashboard on http://localhost:8787 (the same port
//     the bundled server uses in production, so dashboard URLs / muscle
//     memory don't shift between dev and prod).
//   - The dev server runs separately on :41817 (set by
//     `packages/server/package.json`'s `dev` script) and Vite proxies
//     `/api/*` over to it.
// Both ports are deliberately picked away from 3000 / 5173 to dodge the
// extremely common JS-tooling collisions (Next.js, CRA, Express, plain
// Vite defaults all default to those).
//
// ⚠️  The 41817 literal below MUST stay in lock-step with the
//     `cross-env PORT=41817` in packages/server/package.json's `dev`
//     script. If they drift, dev `/api/*` requests will silently
//     ECONNREFUSED with no useful error.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 8787,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:41817",
    },
  },
});
