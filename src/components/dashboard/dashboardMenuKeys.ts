import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Native details/summary keeps Tab and Enter; arrows and Escape add menu navigation. */
export function dashboardMenuKeys(event: ReactKeyboardEvent<HTMLDetailsElement> | KeyboardEvent, menu = event.currentTarget as HTMLDetailsElement) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const summary = menu.querySelector("summary");
  if (event.key === "Escape") {
    if (!menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    menu.open = false;
    syncDashboardMenuPopup(menu);
    summary?.focus();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const entries = [...menu.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex='0']")]
    .filter(entry => entry.closest("details") === menu);
  if (!entries.length) return;
  event.preventDefault();
  event.stopPropagation();
  menu.open = true;
  syncDashboardMenuPopup(menu);
  const current = entries.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
    : event.key === "ArrowDown" ? (current + 1) % entries.length
      : (current < 0 ? entries.length - 1 : (current - 1 + entries.length) % entries.length);
  entries[next]?.focus();
}

/** Use the native top layer only when a column would clip its menu. DOM ancestry and theme stay intact. */
export function syncDashboardMenuPopup(menu: HTMLDetailsElement): void {
  const panel = menu.querySelector<HTMLElement>("[data-dashboard-menu-popup]");
  if (!panel) return;
  if (panel.hasAttribute("popover")) {
    panel.hidePopover?.();
    panel.removeAttribute("popover");
    for (const property of ["position", "left", "right", "top", "bottom", "margin"]) panel.style.removeProperty(property);
  }
  if (!menu.open) return;
  const column = menu.closest<HTMLElement>(".cmux-dashboard-chat-column");
  if (!column) return;
  const bounds = column.getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  const clipped = rect.left < bounds.left || rect.right > bounds.right || rect.bottom > bounds.bottom;
  if (!clipped || !panel.showPopover) return;
  const anchor = menu.querySelector("summary")!.getBoundingClientRect();
  const left = Math.max(0, Math.min(window.innerWidth - rect.width, anchor.right - rect.width));
  const top = Math.max(0, Math.min(window.innerHeight - rect.height, anchor.bottom));
  panel.setAttribute("popover", "manual");
  Object.assign(panel.style, { position: "fixed", left: `${left}px`, right: "auto", top: `${top}px`, bottom: "auto", margin: "0" });
  panel.showPopover();
}
