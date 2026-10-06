// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToastHost from "../../src/components/common/ToastHost";
import { toastStrings } from "../../src/components/workspace/terminalPaneStrings";
import { useSettingsStore } from "../../src/stores/settingsStore";
import { __resetToastStoreForTests, useToastStore, type ToastAction } from "../../src/stores/toastStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  __resetToastStoreForTests();
  useSettingsStore.setState({ notificationsEnabled: true, toastUserActionEnabled: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  __resetToastStoreForTests();
  host.remove();
});

async function renderToast(action?: ToastAction, actions?: ToastAction[]): Promise<HTMLElement> {
  useToastStore.getState().pushToast("Recovery failed with a long explanation", "error", action, actions);
  await act(async () => root.render(<ToastHost />));
  return host.querySelector<HTMLElement>("[role='alert']")!;
}

describe("ToastHost action layout", () => {
  it.each(["legacy", "single", "two"] as const)("places %s actions below the full-width message", async (variant) => {
    const actions = [{ label: "Retry attachment", run: vi.fn() }, { label: "Visit the pane", run: vi.fn() }];
    const toast = await renderToast(variant === "legacy" ? actions[0] : undefined,
      variant === "legacy" ? undefined : variant === "single" ? actions.slice(0, 1) : actions);
    const message = toast.querySelector<HTMLSpanElement>(":scope > span")!;
    const row = message.nextElementSibling as HTMLSpanElement;
    expect(toast.style.gridTemplateColumns).toBe("18px minmax(0, 1fr) auto");
    expect(row.style.gridRow).toBe("2");
    expect(row.style.gridColumn).toBe("2 / -1");
    expect(row.style.flexWrap).toBe("wrap");
    const buttons = [...row.querySelectorAll("button")];
    expect(buttons).toHaveLength(variant === "two" ? 2 : 1);
    for (const button of buttons) {
      expect(button.style.whiteSpace).toBe("nowrap");
      expect(button.style.flexShrink).toBe("0");
    }
    const close = toast.querySelector<HTMLButtonElement>(`[aria-label="${toastStrings.close}"]`)!;
    expect(close.parentElement).toBe(toast);
    expect(close.style.gridRow).toBe("");
  });

  it("preserves the original three-column presentation when there are no actions", async () => {
    const toast = await renderToast();
    expect(toast.style.gridTemplateColumns).toBe("18px minmax(0, 1fr) auto");
    expect(toast.style.gap).toBe("10px");
    expect(toast.style.padding).toBe("10px 12px");
    expect(toast.querySelectorAll(":scope > span")).toHaveLength(1);
    expect(toast.querySelectorAll("button")).toHaveLength(1);
    expect(toast.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(toast.lastElementChild?.getAttribute("aria-label")).toBe(toastStrings.close);
  });

  it("runs each matching action once and dismisses only its own toast", async () => {
    const firstRun = vi.fn();
    const secondRun = vi.fn();
    const firstToast = await renderToast({ label: "Undo", run: firstRun });
    const firstId = useToastStore.getState().toasts[0].id;
    let secondId = "";
    await act(async () => {
      secondId = useToastStore.getState().pushToast("Recovery failed with a long explanation", "error",
        undefined, [{ label: "Undo", run: secondRun }]);
    });
    expect(secondId).not.toBe(firstId);
    const toasts = [...host.querySelectorAll<HTMLElement>("[role='alert']")];
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toBe(firstToast);
    const undoButton = (toast: HTMLElement) => [...toast.querySelectorAll("button")].find((button) => button.textContent === "Undo")!;
    await act(async () => undoButton(toasts[0]).click());
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([secondId]);
    expect([...host.querySelectorAll("[role='alert']")]).toEqual([toasts[1]]);
    await act(async () => undoButton(toasts[1]).click());
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(host.querySelector("[role='alert']")).toBeNull();
  });

  it.each(["close", "Escape", "body"] as const)("still dismisses an action toast with %s", async (method) => {
    const run = vi.fn();
    const toast = await renderToast({ label: "Retry attachment", run });
    await act(async () => {
      if (method === "close") toast.querySelector<HTMLButtonElement>(`[aria-label="${toastStrings.close}"]`)!.click();
      else if (method === "body") toast.click();
      else toast.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
