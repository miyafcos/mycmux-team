import ReactDOM from "react-dom/client";
import { Profiler } from "react";
import App from "./App";
import { initializePerfDiagnostics } from "./lib/perfDiagnostics";
import { installPerfTimeline } from "./lib/perfTimeline";
import { recordReactCommit } from "./lib/paintStats";
import { useToastStore } from "./stores/toastStore";
import { IS_MAC } from "./lib/keybindings";
import { installE2eHooks } from "./lib/e2eHooks";
import "./global.css";

// Sole unhandledrejection handler for the app (App.tsx used to register a second
// one). preventDefault() is deliberately NOT called: the only stated reason for
// it was generic crash-proofing (03cfd61), and suppressing the default report
// hides the rejection from devtools.
const UNHANDLED_REJECTION_TOAST_THROTTLE_MS = 15000;
let lastUnhandledRejectionToastAt = 0;

window.addEventListener("unhandledrejection", (e) => {
  console.error("[mycmux] unhandled rejection:", e.reason);
  const now = Date.now();
  if (now - lastUnhandledRejectionToastAt < UNHANDLED_REJECTION_TOAST_THROTTLE_MS) return;
  lastUnhandledRejectionToastAt = now;
  const rawDetail = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
  const detail = rawDetail.length > 160 ? `${rawDetail.slice(0, 160)}…` : rawDetail;
  useToastStore
    .getState()
    .pushToast(
      detail
        ? `内部エラーが発生しました: ${detail}`
        : "内部エラーが発生しました (詳細はコンソール)",
      "warning",
    );
});

window.addEventListener("error", (e) => {
  console.error("[mycmux] uncaught error:", e.error ?? e.message);
});

// Suppress the WebView2 native context menu everywhere. That menu runs a modal
// message loop in its own window, and it opens while our focus controller is
// still retrying focus and the selection-copy path may run a synchronous
// execCommand("copy") — a combination observed to hang the whole app on
// right-click. Nothing in the UI depends on the native menu; in-app menus are
// plain DOM and open fine with preventDefault in place, and the right-click
// selection-copy listener still fires (preventDefault does not stop
// propagation).
window.addEventListener("contextmenu", (e) => e.preventDefault());

installPerfTimeline();

if (import.meta.env.DEV) {
  initializePerfDiagnostics();
}

// The bundled terminal face has to be resolved before anything paints. xterm's
// WebGL renderer bakes a glyph atlas from whichever font is live when it first
// draws, and `font-display: block` on its own does not hold React back -- so a
// terminal opened during the load spends the rest of its session drawing from
// an atlas built on the fallback face, at the wrong cell width.
const BUNDLED_FONT_TIMEOUT_MS = 3000;

async function waitForBundledFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('400 16px "UDEV Gothic NF"'),
        document.fonts.load('700 16px "UDEV Gothic NF"'),
      ]),
      // A slow or broken asset must not turn into a blank window. The CSS stack
      // still falls through to a system monospace face if this times out.
      new Promise((resolve) => setTimeout(resolve, BUNDLED_FONT_TIMEOUT_MS)),
    ]);
  } catch (error) {
    console.error("[mycmux] bundled font load failed:", error);
  }
}

// Text rendering differs enough between the two platforms to need saying so in
// the DOM. Windows draws through DirectWrite, which hints and thickens; macOS
// draws through CoreText, which does neither, and `-webkit-font-smoothing:
// antialiased` — a property Windows ignores entirely — thins it further. Side
// by side on 2026-09-10 the same tokens read as solid text on Windows and as
// faint grey on the Mac, worst on a 1x display. The stylesheet keys off this.
document.documentElement.dataset.platform = IS_MAC ? "mac" : "other";

function mount(): void {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    import.meta.env.DEV ? (
      <Profiler id="mycmux-root" onRender={recordReactCommit}>
        <App />
      </Profiler>
    ) : (
      <App />
    ),
  );
}

installE2eHooks();
void waitForBundledFonts().then(mount);
