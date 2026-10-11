import { readFileSync } from "node:fs";
import ts from "typescript";

// Run the production AppShell handler, including its helpers, without loading
// the native application. Callers supply the real stores and close operation.
const shell = readFileSync("src/components/layout/AppShell.tsx", "utf8");
const plainKeys = shell.slice(shell.indexOf("const TERMINAL_PLAIN_INPUT_KEYS ="), shell.indexOf("// Read back"));
const helpers = shell.slice(shell.indexOf("function paneMatchesSession("), shell.indexOf("// Compact fallback"));
const keydown = shell.slice(shell.indexOf("const onKeyDown = (e: KeyboardEvent) =>"), shell.indexOf('window.addEventListener("keydown", onKeyDown)'));
const factory = new Function("stateRef", "useWorkspaceListStore", "useUiStore", "getActionsForEvent", "isEditableTarget",
  "closePaneOperation", "focusController", "setActivePaneTab", "findPaneInDirection", "toggleDashboard", "openDashboardForActiveSession", "lastFocusedPaneRef",
  ts.transpile(`${plainKeys}\n${helpers}\n${keydown}\nreturn onKeyDown;`));

export function makeAppShellKeydown(...dependencies: unknown[]): (event: KeyboardEvent) => void {
  return factory(...Array.from({ length: 11 }, (_, index) => dependencies[index]), dependencies[11] ?? { current: null });
}

export function trackAppShellPaneFocus(getWorkspace: () => unknown, doc = document) {
  const memory = { current: null as { workspaceId: string; paneId: string } | null };
  const start = new Function("doc", "getWorkspace", "remember", ts.transpile(`${helpers}\nreturn typeof trackDocumentPaneFocus === 'function' ? trackDocumentPaneFocus(doc, getWorkspace, remember) : () => {};`));
  const dispose: () => void = start(doc, getWorkspace, (owner: typeof memory.current) => { memory.current = owner; });
  return { memory, dispose };
}
