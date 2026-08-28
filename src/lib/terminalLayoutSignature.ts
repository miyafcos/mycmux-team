/**
 * The signature that decides when terminals are told their layout moved.
 *
 * `TerminalGrid` dispatches `mycmux:terminal-layout-change` whenever this
 * string changes, and each terminal answers by refitting. Anything that
 * resizes a pane therefore has to appear here — including changes that leave
 * the grid container, the column layout and the pane list untouched.
 *
 * Zoom is exactly such a change, and leaving it out cost us a real bug: zooming
 * a pane and restoring it fired no event, the terminal's own ResizeObserver had
 * already dropped its pending refit while the container was briefly
 * unpaintable, and the pane stayed mis-sized until something unrelated (a
 * sidebar drag) moved the viewport and finally fired the event. That is why the
 * fields live in one tested function instead of inline in a `useMemo`.
 */
export interface TerminalLayoutSignatureInput {
  workspaceId: string;
  viewportSize: { width: number; height: number };
  layoutColumns: readonly (readonly string[])[];
  panes: readonly { id: string; activeTabId?: string | null; tabs: readonly unknown[] }[];
  zoomedPaneId: string | null;
}

export function terminalLayoutSignatureOf(input: TerminalLayoutSignatureInput): string {
  const columnSignature = input.layoutColumns.map((col) => col.join(",")).join("|");
  const paneSignature = input.panes
    .map((pane) => `${pane.id}:${pane.activeTabId}:${pane.tabs.length}`)
    .join("|");
  const width = Math.round(input.viewportSize.width);
  const height = Math.round(input.viewportSize.height);
  return `${input.workspaceId}:${width}x${height}:${columnSignature}:${paneSignature}:zoom=${input.zoomedPaneId ?? ""}`;
}
