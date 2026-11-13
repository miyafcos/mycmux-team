import { isDirectory, writeToSession } from "../../lib/ipc";
import { useComposerStore } from "../../stores/composerStore";

function hasVisibleConversation(pane: Element, sessionId: string): boolean {
  const conversation = pane.querySelector<HTMLElement>(".terminal-transcript-panel--tab");
  return conversation?.dataset.terminalTranscriptSession === sessionId
    && !conversation.closest("[hidden],[aria-hidden=true],[inert]");
}

/** Route a native file drop to the pane under the pointer. */
export async function handleTerminalPathDrop(paths: readonly string[], target: Element | null): Promise<void> {
  if (!paths.length) return;
  const pane = target?.closest("[data-session-id]");
  const sessionId = pane?.getAttribute("data-session-id");
  if (!pane || !sessionId) return;

  const quoted = paths.map(path => `"${path.replace(/\\/g, "/")}"`).join(" ");
  const routeToDraftOrCancel = () => {
    if (!pane.isConnected || pane.getAttribute("data-session-id") !== sessionId
      || pane.closest("[hidden],[aria-hidden=true],[inert]")
      || (typeof pane.checkVisibility === "function" && !pane.checkVisibility({ visibilityProperty: true }))) return true;
    if (!hasVisibleConversation(pane, sessionId)) return false;
    const composer = useComposerStore.getState();
    const draft = composer.draftBySession[sessionId] ?? "";
    const separator = draft && !/\s$/.test(draft) ? " " : "";
    composer.setDraft(sessionId, draft + separator + quoted + " ");
    return true;
  };
  if (routeToDraftOrCancel()) return;

  if (paths.length === 1) {
    try {
      if (await isDirectory(paths[0])) {
        const normalized = paths[0].replace(/\\/g, "/");
        if (routeToDraftOrCancel()) return;
        await writeToSession(sessionId, `cd "${normalized}"\r`);
        return;
      }
    } catch { /* fall through to paste */ }
  }
  if (routeToDraftOrCancel()) return;
  await writeToSession(sessionId, quoted + " ");
}
