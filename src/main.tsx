import ReactDOM from "react-dom/client";
import App from "./App";
import { initializePerfDiagnostics } from "./lib/perfDiagnostics";
import "./global.css";

window.addEventListener("unhandledrejection", (e) => {
  console.error("[mycmux] unhandled rejection:", e.reason);
});

window.addEventListener("error", (e) => {
  console.error("[mycmux] uncaught error:", e.error ?? e.message);
});

initializePerfDiagnostics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
