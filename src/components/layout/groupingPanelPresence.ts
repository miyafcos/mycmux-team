let openCount = 0;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

export function getGroupingPanelOpen(): boolean {
  return openCount > 0;
}

export function subscribeGroupingPanelOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Returns a disposer; call it exactly once per acquire. */
export function acquireGroupingPanelOpen(): () => void {
  const wasOpen = openCount > 0;
  openCount += 1;
  if (!wasOpen) notifyListeners();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount -= 1;
    if (openCount === 0) notifyListeners();
  };
}
