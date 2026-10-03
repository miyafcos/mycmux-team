// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}),
  close: null as null | ((event: { preventDefault: () => void }) => void),
  destroyed: null as null | (() => void), unlisten: vi.fn(),
  listen: vi.fn(), once: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
import { cancelAppConfirmations, confirm } from "../../src/lib/appConfirmation";
function buttons() { return [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")]; }
beforeEach(() => {
  vi.clearAllMocks();
  native.show.mockResolvedValue(undefined);
  native.close = native.destroyed = null;
  native.listen.mockImplementation(async (_name, handler) => { native.close = handler; return native.unlisten; });
  native.once.mockImplementation(async (_name, handler) => { native.destroyed = handler; return native.unlisten; });
});
afterEach(() => { cancelAppConfirmations(); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("app confirmation state", () => {
  it("stays pending indefinitely without freezing JS or approving", async () => {
    vi.useFakeTimers();
    let settled = false;
    const answer = confirm("<script>literal</script>", { title: "Question", okLabel: "Continue", cancelLabel: "Cancel" });
    void answer.then(() => { settled = true; });
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("<script>literal</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(document.activeElement).toBe(buttons()[0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    buttons()[1].click();
    await expect(answer).resolves.toBe(true);
  });
  it("Esc declines and restores background properties and focus", async () => {
    const origin = document.createElement("button"); origin.textContent = "Origin";
    origin.setAttribute("aria-hidden", "false"); document.body.append(origin); origin.focus();
    const answer = confirm("Keep the wording", { okLabel: "Yes", cancelLabel: "No" });
    expect(origin.hasAttribute("inert")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons()[1]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await expect(answer).resolves.toBe(false);
    expect(origin.hasAttribute("inert")).toBe(false);
    expect(origin.getAttribute("aria-hidden")).toBe("false");
    expect(document.activeElement).toBe(origin);
  });
  it("queues independent requests and cancels all on pagehide", async () => {
    const first = confirm("First");
    const second = confirm("Second");
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
    buttons()[1].click();
    await expect(first).resolves.toBe(true);
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("Second");
    const third = confirm("Third");
    window.dispatchEvent(new Event("pagehide"));
    await expect(second).resolves.toBe(false);
    await expect(third).resolves.toBe(false);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(cancelAppConfirmations()).toBe(false);
  });
  it.each(["main", "mycmux-w2"])("foregrounds %s and treats native close as No", async (_label) => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const answer = confirm("Question");
    await Promise.resolve();
    expect(native.show).toHaveBeenCalledOnce();
    expect(native.setFocus).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    native.close?.({ preventDefault });
    await expect(answer).resolves.toBe(false);
    expect(native.listen).toHaveBeenCalledWith("tauri://close-requested", expect.any(Function));
    expect(preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(native.unlisten).toHaveBeenCalledTimes(2);
  });
  it("does not wait for a hung show API before displaying or cancelling", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.show.mockReturnValueOnce(new Promise(() => {}));
    const first = confirm("Unresponsive window API");
    const second = confirm("Queued");
    native.destroyed?.();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });
});
