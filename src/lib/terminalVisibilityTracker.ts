type Entry = {
  workspaceId: string;
  onVisibilityChange: () => void;
  onLayoutChange: () => void;
};

const entries = new Map<Element, Entry>();
let observer: IntersectionObserver | null = null;
let listenersAttached = false;

function notifyVisibility(): void {
  for (const entry of entries.values()) entry.onVisibilityChange();
}

function notifyLayout(event: Event): void {
  const workspaceId = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId;
  for (const entry of entries.values()) {
    if (!workspaceId || entry.workspaceId === workspaceId) entry.onLayoutChange();
  }
}

function attachListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener("focus", notifyVisibility);
  window.addEventListener("blur", notifyVisibility);
  window.addEventListener("mycmux:workspace-visibility-change", notifyVisibility);
  window.addEventListener("mycmux:terminal-layout-change", notifyLayout);
  document.addEventListener("visibilitychange", notifyVisibility);
}

function detachListeners(): void {
  if (!listenersAttached) return;
  listenersAttached = false;
  window.removeEventListener("focus", notifyVisibility);
  window.removeEventListener("blur", notifyVisibility);
  window.removeEventListener("mycmux:workspace-visibility-change", notifyVisibility);
  window.removeEventListener("mycmux:terminal-layout-change", notifyLayout);
  document.removeEventListener("visibilitychange", notifyVisibility);
}

export function observeTerminalVisibility(
  element: Element,
  workspaceId: string,
  onVisibilityChange: () => void,
  onLayoutChange: () => void,
): () => void {
  if (!observer && typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((records) => {
      for (const record of records) entries.get(record.target)?.onVisibilityChange();
    });
  }
  entries.set(element, { workspaceId, onVisibilityChange, onLayoutChange });
  observer?.observe(element);
  attachListeners();
  onVisibilityChange();
  return () => {
    entries.delete(element);
    observer?.unobserve(element);
    if (entries.size === 0) {
      observer?.disconnect();
      observer = null;
      detachListeners();
    }
  };
}
