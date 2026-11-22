import type { Terminal } from "@xterm/xterm";
import { diagnosticException, reportTerminalDiagnostic } from "../../lib/terminalDiagnostics";
import { useToastStore } from "../../stores/toastStore";
import { terminalPaneStrings } from "../workspace/terminalPaneStrings";

type RepaintTarget = { term: Terminal; repaint: () => void };
const mountedDisplays = new Map<string, () => RepaintTarget | undefined>();
const lastAttempt = new Map<string, number>();
const MANUAL_REPAINT_COOLDOWN_MS = 2000;

export function registerManualDisplayRepaint(id: string, target: () => RepaintTarget | undefined): () => void {
  mountedDisplays.set(id, target);
  return () => { if (mountedDisplays.get(id) === target) mountedDisplays.delete(id); };
}

export function repaintDisplayFromMenu(id: string, selected: boolean): void {
  const target = selected ? mountedDisplays.get(id)?.() : undefined;
  const { pushToast } = useToastStore.getState();
  if (!target) {
    pushToast(terminalPaneStrings.displayRestoreUnavailable, "warning");
    return;
  }
  const now = Date.now();
  const previous = lastAttempt.get(id);
  if (previous !== undefined && now >= previous && now - previous < MANUAL_REPAINT_COOLDOWN_MS) return;
  lastAttempt.set(id, now);
  setTimeout(() => {
    if (lastAttempt.get(id) === now) lastAttempt.delete(id);
  }, MANUAL_REPAINT_COOLDOWN_MS);
  const report = (event: "end" | "failed", error?: unknown) =>
    reportTerminalDiagnostic("recovery", event, id, target.term, { reused: 1, observed_at_ms: now },
      { reason: "manual", exception: event === "failed" ? diagnosticException(error) : "none" });
  try { target.repaint(); }
  catch (error) {
    report("failed", error);
    pushToast(terminalPaneStrings.displayRepaintFailed, "error");
    return;
  }
  report("end");
  pushToast(terminalPaneStrings.displayRepainted, "info");
}
