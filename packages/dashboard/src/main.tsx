import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import "./styles.css";

// Bootstrap is wrapped in an async IIFE so MSW's worker.start() finishes
// before React commits its first render — otherwise the first fetch in
// the page (often /api/health from serverClock.startClockSync) would
// race past MSW and hit the (non-existent) real backend.
//
// The mocks/ subtree is loaded via dynamic import behind a build-time
// env-flag check so vite tree-shakes the whole MSW + fixture set out
// of the prod bundle. The canary test in
// test/no-mocks-in-prod-bundle.test.ts pins that contract.
async function bootstrap(): Promise<void> {
  if (import.meta.env.VITE_USE_MOCKS === "1") {
    const { worker } = await import("./mocks/browser.js");
    // "warn" (not "error") so the browser's favicon.ico / devtools
    // probes don't fail-fast and break the page during designer
    // iteration.
    await worker.start({ onUnhandledRequest: "warn" });
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

void bootstrap();
