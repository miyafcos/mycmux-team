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

const reservationMessage = "前の移動の確定を待っています。確認が終わってからもう一度操作してください。";

async function renderThreeActions() {
  const actions = ["Undo", "Retry", "Visit"].map(label => ({ label, run: vi.fn() }));
  const ids = actions.map((action, index) => useToastStore.getState().pushToast(
    `Existing operation ${index}`, "info", action, undefined, 20_000,
  ));
  await act(async () => root.render(<ToastHost />));
  const cards = [...host.querySelectorAll<HTMLElement>('[role="status"]')];
  return { actions, ids, cards, stack: cards[0].parentElement! };
}

async function renderReservation(message = reservationMessage) {
  await act(async () => { useToastStore.getState().pushTransferReservationNotice(message); });
  const card = [...host.querySelectorAll<HTMLElement>('[role="status"]')]
    .find(element => element.querySelector(":scope > span")?.textContent === message)!;
  expect(card).toBeDefined();
  return { card, container: card.parentElement!, message: card.querySelector<HTMLElement>(":scope > span")! };
}

describe("V3 mandatory reservation notice structure (jsdom, no layout calculation)", () => {
  it("anchors the explanation to the window separately from three existing action toasts", async () => {
    const { stack, cards } = await renderThreeActions();
    const { container, card } = await renderReservation();
    expect(container).not.toBe(stack);
    expect(stack.contains(card)).toBe(false);
    expect(container.contains(stack)).toBe(false);
    expect(container.style.position).toBe("fixed");
    expect(container.style.top).toBe("16px");
    expect(container.style.left).toBe("16px");
    expect(container.style.bottom).toBe("");
    expect(container.getAttribute("aria-live")).toBe("polite");
    expect([...stack.querySelectorAll('[role="status"]')]).toEqual(cards);
  });

  it.each([
    ["normal", reservationMessage],
    ["long", reservationMessage.repeat(30) + "unbroken-transfer-token".repeat(30)],
  ])("bounds and scrolls the %s explanation while keeping its close control outside the scrolling text", async (_name, text) => {
    await renderThreeActions();
    const { container, card, message } = await renderReservation(text);
    expect(container.style.width).toBe("320px");
    expect(container.style.maxWidth).toBe("calc(100vw - 32px)");
    expect(container.style.maxHeight).toBe("calc(100vh - 32px)");
    expect(card.style.maxHeight).toBe("inherit");
    expect(card.style.overflow).toBe("hidden");
    expect(message.style.maxHeight).toBe("calc(100vh - 54px)");
    expect(Number.parseFloat(message.style.minHeight)).toBe(0);
    expect(message.style.overflowY).toBe("auto");
    expect(message.style.overflowWrap).toBe("anywhere");
    expect(message.tabIndex).toBe(0);
    const close = card.querySelector<HTMLButtonElement>(`[aria-label="${toastStrings.close}"]`)!;
    expect(close.parentElement).toBe(card);
    expect(message.contains(close)).toBe(false);
    expect(close.style.alignSelf).toBe("start");
    expect(close.style.gridColumn).toBe("3");
    expect(close.style.gridRow).toBe("1");
  });

  it("retains the original stack, card positions, IDs, order and callbacks through repetition and notice dismissal", async () => {
    const { stack, cards, actions, ids } = await renderThreeActions();
    const stackStyle = stack.getAttribute("style");
    const cardStyles = cards.map(card => card.getAttribute("style"));
    const actionButtons = actions.map((action, index) => [...cards[index].querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === action.label)!);
    const { card } = await renderReservation();
    await renderReservation();
    expect([...stack.querySelectorAll('[role="status"]')]).toEqual(cards);
    expect(stack.getAttribute("style")).toBe(stackStyle);
    expect(cards.map(card => card.getAttribute("style"))).toEqual(cardStyles);
    expect(useToastStore.getState().toasts.map(toast => toast.id)).toEqual(ids);
    expect(useToastStore.getState().toasts.map(toast => toast.action)).toEqual(actions);
    await act(async () => card.querySelector<HTMLButtonElement>(`[aria-label="${toastStrings.close}"]`)!.click());
    expect(useToastStore.getState().transferReservationNotice).toBeNull();
    expect([...stack.querySelectorAll('[role="status"]')]).toEqual(cards);
    expect(stack.getAttribute("style")).toBe(stackStyle);
    await act(async () => { actionButtons.forEach(button => button.click()); });
    for (const action of actions) expect(action.run).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
