import ReactDOM from "react-dom/client";
import { Profiler } from "react";
import App from "./App";
import { initializePerfDiagnostics } from "./lib/perfDiagnostics";
import { recordReactCommit } from "./lib/paintStats";
import "./global.css";

window.addEventListener("unhandledrejection", (e) => {
  console.error("[mycmux] unhandled rejection:", e.reason);
});

window.addEventListener("error", (e) => {
  console.error("[mycmux] uncaught error:", e.error ?? e.message);
});

initializePerfDiagnostics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? (
    <Profiler id="mycmux-root" onRender={recordReactCommit}>
      <App />
    </Profiler>
  ) : (
    <App />
  ),
);
