import ReactDOM from "react-dom/client";
import { Profiler } from "react";
import App from "./App";
import { initializePerfDiagnostics } from "./lib/perfDiagnostics";
import { recordReactCommit } from "./lib/paintStats";
import { useToastStore } from "./stores/toastStore";
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

if (import.meta.env.DEV) {
  initializePerfDiagnostics();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? (
    <Profiler id="mycmux-root" onRender={recordReactCommit}>
      <App />
    </Profiler>
  ) : (
    <App />
  ),
);
