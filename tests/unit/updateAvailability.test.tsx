// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunch: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/components/feedback/FeedbackDestinationSection", () => ({
  FeedbackDestinationSection: () => null,
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.0" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("../../src/stores/toastStore", () => ({
  useToastStore: { getState: () => ({ pushToast: vi.fn() }) },
}));

let updater: typeof import("../../src/lib/forcedAutoUpdater");
let context: typeof import("../../src/lib/windowContext");
let availability: typeof import("../../src/stores/updateAvailabilityStore").useUpdateAvailabilityStore;
let scheduler: typeof import("../../src/lib/updateAvailabilityScheduler");
let UpdateButton: typeof import("../../src/components/layout/UpdateButton").UpdateButton;
let AppInfoTab: typeof import("../../src/components/settings/tabs/AppInfoTab").AppInfoTab;
let host: HTMLDivElement;
let root: Root;
let stops: Array<() => void>;

const label = "v1.1.0 に更新できます";
const warning = "更新すると mycmux を再起動します。タブは開き直されますが、動いている作業は止まります。";
const failure = "更新できませんでした。時間をおいてもう一度押してください。";

function update() {
  return { version: "1.1.0", currentVersion: "1.0.0",
    downloadAndInstall: mocks.downloadAndInstall, close: mocks.close };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount(node: ReactNode) {
  await act(async () => root.render(node));
}
function mark() {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}
function button(text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
  expect(found, text).toBeDefined();
  return found!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function discover() {
  await act(async () => { await updater.runUpdateCheck({ source: "manual" }); });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function start() {
  await act(async () => { stops.push(scheduler.startAutomaticUpdateChecks()); });
}
async function event(name: "online" | "visibilitychange") {
  await act(async () => {
    (name === "online" ? window : document).dispatchEvent(new Event(name));
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => window.clearTimeout(frame));
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubEnv("DEV", false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.check.mockResolvedValue(update());
  mocks.invoke.mockResolvedValue(null);
  mocks.downloadAndInstall.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  context = await import("../../src/lib/windowContext");
  context.setWindowRole(true);
  updater = await import("../../src/lib/forcedAutoUpdater");
  availability = (await import("../../src/stores/updateAvailabilityStore")).useUpdateAvailabilityStore;
  scheduler = await import("../../src/lib/updateAvailabilityScheduler");
  UpdateButton = (await import("../../src/components/layout/UpdateButton")).UpdateButton;
  AppInfoTab = (await import("../../src/components/settings/tabs/AppInfoTab")).AppInfoTab;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  stops = [];
});
afterEach(async () => {
  stops.forEach((stop) => stop());
  await act(async () => { root.unmount(); context.setWindowRole(false); });
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("update mark and confirmation", () => {
  it("renders nothing, including a wrapper, when no update is available", async () => {
    await mount(createElement(UpdateButton, { testProfile: null }));
    expect(host.childNodes).toHaveLength(0);
    mocks.check.mockResolvedValue(null);
    await discover();
    expect(host.childNodes).toHaveLength(0);
    expect(availability.getState().state).toBe("none");
  });

  it("keeps the update handle private and renders the blue download mark and shared copy", async () => {
    await mount(createElement(UpdateButton, { testProfile: null }));
    await discover();
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
    expect(availability.getState()).toEqual({
      state: "available", version: "1.1.0", currentVersion: "1.0.0", message: "",
    });
    expect(mark()?.title).toBe(label);
    expect(mark()?.style.color).toBe("var(--cmux-accent)");
    expect(mark()?.querySelector("svg")?.getAttribute("stroke-width")).toBe("2");
    await act(async () => mark()?.click());
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("mycmux を更新");
    expect(dialog?.textContent).toContain("v1.0.0 → v1.1.0");
    expect(dialog?.textContent).toContain(warning);
    expect(button("更新して再起動").disabled).toBe(false);
    expect(button("あとで")).toBeDefined();
  });

  it.each(["later", "escape", "outside"] as const)("closes with %s and leaves the mark available", async (gesture) => {
    await discover();
    await mount(createElement(UpdateButton, { testProfile: null }));
    await act(async () => mark()?.click());
    expect(mark()?.getAttribute("aria-expanded")).toBe("true");
    if (gesture === "later") await click("あとで");
    if (gesture === "escape") {
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(document.activeElement).toBe(mark());
    }
    if (gesture === "outside") {
      await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    }
    expect(mark()?.getAttribute("aria-expanded")).toBe("false");
    await advance(121);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(mark()).not.toBeNull();
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("downloads once for repeated confirmation and relaunches only after download finishes", async () => {
    const download = deferred<void>();
    mocks.downloadAndInstall.mockReturnValue(download.promise);
    await discover();
    await mount(createElement(UpdateButton, { testProfile: null }));
    await act(async () => mark()?.click());
    await act(async () => {
      button("更新して再起動").click();
      button("更新して再起動").click();
    });
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(button("更新して再起動").disabled).toBe(true);
    expect(host.textContent).toContain("v1.1.0 を取得しています…");
    await act(async () => download.resolve());
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.downloadAndInstall.mock.invocationCallOrder[0]).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });

  it("shows a download failure, retains the mark and handle, and allows retry", async () => {
    mocks.downloadAndInstall.mockRejectedValueOnce(new Error("offline"));
    await discover();
    await mount(createElement(UpdateButton, { testProfile: null }));
    await act(async () => mark()?.click());
    await click("更新して再起動");
    expect(host.textContent).toContain(failure);
    expect(availability.getState().message).toBe(failure);
    expect(availability.getState().state).toBe("error");
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mark()).not.toBeNull();
    expect(button("更新して再起動").disabled).toBe(false);
    await click("更新して再起動");
    expect(mocks.downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("retains a retryable error when relaunch fails", async () => {
    mocks.relaunch.mockRejectedValueOnce(new Error("restart failed"));
    await discover();
    await mount(createElement(UpdateButton, { testProfile: null }));
    await act(async () => mark()?.click());
    await click("更新して再起動");
    expect(host.textContent).toContain(failure);
    expect(button("更新して再起動").disabled).toBe(false);
    expect(mark()).not.toBeNull();
  });

  it("does not start installation after the window loses its role", async () => {
    await discover();
    context.setWindowRole(false);
    await updater.installAvailableUpdate();
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("rechecks the TEST guard before installation", async () => {
    await discover();
    mocks.invoke.mockResolvedValue("test");
    await updater.installAvailableUpdate();
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("does not replace an in-flight installation with a new check", async () => {
    const download = deferred<void>();
    mocks.downloadAndInstall.mockReturnValue(download.promise);
    await discover();
    const installation = updater.installAvailableUpdate();
    await act(async () => {});
    const checking = updater.runUpdateCheck({ source: "manual" });
    expect(mocks.check).toHaveBeenCalledOnce();
    download.resolve();
    await Promise.all([installation, checking]);
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("disposes the old handle when the feed no longer reports an update", async () => {
    await discover();
    mocks.check.mockResolvedValue(null);
    await discover();
    expect(availability.getState().state).toBe("none");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not publish a check that finishes after losing the role", async () => {
    const checking = deferred<ReturnType<typeof update>>();
    mocks.check.mockReturnValue(checking.promise);
    const task = updater.runUpdateCheck({ source: "manual" });
    await act(async () => {});
    context.setWindowRole(false);
    checking.resolve(update());
    await task;
    expect(availability.getState().state).toBe("none");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping checks into one request", async () => {
    const checking = deferred<ReturnType<typeof update>>();
    mocks.check.mockReturnValue(checking.promise);
    const a = updater.runUpdateCheck({ source: "manual" });
    const b = updater.runUpdateCheck({ source: "manual" });
    await act(async () => {});
    expect(mocks.check).toHaveBeenCalledOnce();
    checking.resolve(update());
    await Promise.all([a, b]);
  });
});

describe("automatic discovery", () => {
  it("checks at 30 seconds and every 60 minutes, and cleans up its timers", async () => {
    await start();
    await advance(29_999);
    expect(mocks.check).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.check).toHaveBeenCalledOnce();
    await advance(60 * 60_000 - 1);
    expect(mocks.check).toHaveBeenCalledOnce();
    await advance(1);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    stops.forEach((stop) => stop());
    await advance(120 * 60_000);
    await event("online");
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("throttles online and visible resumes for 30 minutes and ignores hidden resumes", async () => {
    await start();
    await advance(30_000);
    await advance(29 * 60_000 + 55_000);
    await event("online");
    await event("visibilitychange");
    expect(mocks.check).toHaveBeenCalledOnce();
    await advance(5_001);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await event("visibilitychange");
    expect(mocks.check).toHaveBeenCalledOnce();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await event("visibilitychange");
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await event("online");
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await advance(30 * 60_000 + 1);
    await event("online");
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it("does not throttle an explicit settings check", async () => {
    await start();
    await advance(30_000);
    await discover();
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("keeps automatic communication failures invisible and retries at the next interval", async () => {
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    await mount(createElement(UpdateButton, { testProfile: null }));
    await start();
    await advance(30_000);
    expect(host.childNodes).toHaveLength(0);
    expect(availability.getState()).toMatchObject({ state: "none", message: "" });
    await advance(60 * 60_000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mark()).not.toBeNull();
  });

  it("finishes an explicit check that joins a failing automatic request", async () => {
    const checking = deferred<ReturnType<typeof update>>();
    mocks.check.mockReturnValue(checking.promise);
    await mount(createElement(AppInfoTab));
    await start();
    await advance(30_000);
    await act(async () => button("更新を確認").click());
    expect(button("更新を確認").disabled).toBe(true);
    await act(async () => checking.reject(new Error("offline")));
    expect(button("更新を確認").disabled).toBe(false);
    expect(host.textContent).toContain("更新の確認に失敗しました");
    expect(host.textContent).not.toContain(warning);
  });

  it("keeps an existing update unchanged when an automatic refresh fails", async () => {
    await discover();
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    await start();
    await advance(30_000);
    expect(availability.getState()).toMatchObject({ state: "available", message: "" });
  });

  it.each(["development", "no role", "TEST", "unknown profile"] as const)(
    "hides the mark and skips automatic checks for %s", async (reason) => {
      let profile: string | null | undefined = null;
      if (reason === "development") vi.stubEnv("DEV", true);
      if (reason === "no role") context.setWindowRole(false);
      if (reason === "TEST") { profile = "test"; mocks.invoke.mockResolvedValue(profile); }
      if (reason === "unknown profile") { profile = undefined; mocks.invoke.mockRejectedValue(new Error("unavailable")); }
      availability.setState({ state: "available", version: "1.1.0", currentVersion: "1.0.0", message: "" });
      await mount(createElement(UpdateButton, { testProfile: profile }));
      await start();
      await advance(120 * 60_000);
      await event("online");
      await event("visibilitychange");
      expect(mocks.check).not.toHaveBeenCalled();
      expect(host.childNodes).toHaveLength(0);
    },
  );

  it("starts after a late role grant and stops on revocation, then starts again", async () => {
    const onlineRemove = vi.spyOn(window, "removeEventListener");
    const visibleRemove = vi.spyOn(document, "removeEventListener");
    context.setWindowRole(false);
    await start();
    await advance(30_000);
    expect(mocks.check).not.toHaveBeenCalled();
    await act(async () => context.setWindowRole(true));
    await advance(30_000);
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => context.setWindowRole(false));
    expect(vi.getTimerCount()).toBe(0);
    expect(onlineRemove).toHaveBeenCalledWith("online", expect.any(Function));
    expect(visibleRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    await advance(60 * 60_000);
    await event("online");
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => context.setWindowRole(true));
    await advance(30_000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("does not arm timers when a pending profile lookup completes after cleanup", async () => {
    const profile = deferred<null>();
    mocks.invoke.mockReturnValue(profile.promise);
    await start();
    stops.forEach((stop) => stop());
    profile.resolve(null);
    await advance(120 * 60_000);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("hides and restores an already-rendered mark with the live window role", async () => {
    await discover();
    await mount(createElement(UpdateButton, { testProfile: null }));
    expect(mark()).not.toBeNull();
    await act(async () => context.setWindowRole(false));
    expect(host.childNodes).toHaveLength(0);
    await act(async () => context.setWindowRole(true));
    expect(mark()).not.toBeNull();
  });
});


describe("update scheduling and confirmation regressions", () => {
  it("waits for the startup delay before subscribing to online and visible resumes", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await start();
    await advance(10_000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await event("visibilitychange");
    await event("online");
    expect(mocks.check).not.toHaveBeenCalled();
    await advance(20_000);
    expect(mocks.check).toHaveBeenCalledOnce();
    await advance(30 * 60_000 + 1);
    await event("visibilitychange");
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("keeps the hourly interval after a recent resume check", async () => {
    await start();
    await advance(30_000);
    await advance(30 * 60_000 + 30_000);
    await event("visibilitychange");
    expect(mocks.check).toHaveBeenCalledTimes(2);
    // The hourly tick is only 29m30s after this resume, inside its throttle.
    await advance(29 * 60_000 + 30_000);
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it("retries online one minute after a failed startup check", async () => {
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    await start();
    await advance(30_000);
    expect(mocks.check).toHaveBeenCalledOnce();
    await advance(60_000);
    await event("online");
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("restores the preceding successful automatic timestamp after a failed resume", async () => {
    await updater.checkForUpdateAvailability({ source: "startup" });
    await advance(30 * 60_000 + 1);
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    await updater.checkForUpdateAvailability({ source: "resume" });
    await advance(60_000);
    await updater.checkForUpdateAvailability({ source: "online" });
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it("waits for an automatic check and runs a fresh manual check without replaying a stale error", async () => {
    mocks.check.mockRejectedValueOnce(new Error("previous failure"));
    await updater.runUpdateCheck();
    const profile = deferred<null>();
    mocks.invoke.mockReturnValueOnce(profile.promise);
    const automatic = updater.checkForUpdateAvailability({ source: "startup" });
    const statuses: Array<{ phase: string; source?: string }> = [];
    const manual = updater.runUpdateCheck({ onStatus: (status) => statuses.push(status) });
    const earlyStatuses = [...statuses];
    profile.resolve(null);
    const [, result] = await Promise.all([automatic, manual]);
    expect(earlyStatuses).toEqual([]);
    expect(statuses.map(({ phase, source }) => ({ phase, source }))).toEqual([
      { phase: "checking", source: "manual" },
      { phase: "available", source: "manual" },
    ]);
    expect(mocks.check).toHaveBeenCalledTimes(3);
    expect(result.phase).toBe("available");
  });

  it("performs an unthrottled manual check after an automatic check is skipped", async () => {
    await updater.checkForUpdateAvailability({ source: "startup" });
    const profile = deferred<null>();
    mocks.invoke.mockReturnValueOnce(profile.promise);
    const automatic = updater.checkForUpdateAvailability({ source: "resume" });
    const statuses: string[] = [];
    const manual = updater.runUpdateCheck({ onStatus: ({ phase }) => statuses.push(phase) });
    profile.resolve(null);
    const [automaticResult, manualResult] = await Promise.all([automatic, manual]);
    expect(automaticResult.skipped).toBe(true);
    expect(manualResult.phase).toBe("available");
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(["checking", "available"]);
  });

  it("only replays checking when manual checks coalesce", async () => {
    mocks.check.mockRejectedValueOnce(new Error("previous failure"));
    await updater.runUpdateCheck();
    const profile = deferred<null>();
    mocks.invoke.mockReturnValueOnce(profile.promise);
    const first = updater.runUpdateCheck();
    const statuses: string[] = [];
    const second = updater.runUpdateCheck({ onStatus: ({ phase }) => statuses.push(phase) });
    profile.resolve(null);
    await Promise.all([first, second]);
    expect(statuses).toEqual(["checking", "available"]);
    expect(mocks.check).toHaveBeenCalledTimes(2);

    const checking = deferred<ReturnType<typeof update>>();
    mocks.check.mockReturnValueOnce(checking.promise);
    const third = updater.runUpdateCheck();
    await act(async () => {});
    const checkingStatuses: string[] = [];
    const fourth = updater.runUpdateCheck({ onStatus: ({ phase }) => checkingStatuses.push(phase) });
    checking.resolve(update());
    await Promise.all([third, fourth]);
    expect(checkingStatuses).toEqual(["checking", "available"]);
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it("returns installation results without subscribing a manual check to download statuses", async () => {
    await discover();
    const download = deferred<void>();
    mocks.downloadAndInstall.mockReturnValueOnce(download.promise);
    const installation = updater.installAvailableUpdate();
    await act(async () => {});
    const statuses: string[] = [];
    const checking = updater.runUpdateCheck({ onStatus: ({ phase }) => statuses.push(phase) });
    download.resolve();
    const [installed, checked] = await Promise.all([installation, checking]);
    expect(checked).toEqual(installed);
    expect(checked.phase).toBe("ready");
    expect(statuses).toEqual([]);
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it("retries only relaunch after the retained update was installed", async () => {
    mocks.relaunch.mockRejectedValueOnce(new Error("restart failed"));
    await discover();
    expect((await updater.installAvailableUpdate()).phase).toBe("error");
    expect((await updater.installAvailableUpdate()).phase).toBe("ready");
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledTimes(2);
  });

  it("focuses Later when opening and reopening the update panel", async () => {
    await discover();
    await mount(createElement(UpdateButton, { testProfile: null }));
    await act(async () => mark()?.click());
    await advance(20);
    expect(document.activeElement).toBe(button("あとで"));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await advance(121);
    expect(document.activeElement).toBe(mark());
    await act(async () => mark()?.click());
    await advance(20);
    expect(document.activeElement).toBe(button("あとで"));
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("leaves focus on the settings check instead of automatically focusing restart", async () => {
    await mount(createElement(AppInfoTab));
    button("更新を確認").focus();
    const focused = document.activeElement;
    await click("更新を確認");
    await advance(20);
    expect(document.activeElement).toBe(focused);
    expect(button("更新して再起動")).toBeDefined();
  });

  it("installs the new handle after a pending check and only closes the old handle", async () => {
    const oldUpdate = update();
    mocks.check.mockResolvedValueOnce(oldUpdate);
    await discover();
    await mount(createElement(UpdateButton, { testProfile: null }));
    await act(async () => mark()?.click());
    const checking = deferred<ReturnType<typeof update>>();
    mocks.check.mockReturnValueOnce(checking.promise);
    const refresh = updater.runUpdateCheck();
    await act(async () => {});
    await click("更新して再起動");
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
    const newDownload = vi.fn(async () => {});
    const newClose = vi.fn(async () => {});
    await act(async () => {
      checking.resolve({ ...update(), downloadAndInstall: newDownload, close: newClose });
      await refresh;
    });
    expect(newDownload).toHaveBeenCalledOnce();
    expect(newClose).not.toHaveBeenCalled();
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
    expect(oldUpdate.close).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("does not remove event subscriptions that were never armed before startup", async () => {
    const onlineAdd = vi.spyOn(window, "addEventListener");
    const visibleAdd = vi.spyOn(document, "addEventListener");
    const onlineRemove = vi.spyOn(window, "removeEventListener");
    const visibleRemove = vi.spyOn(document, "removeEventListener");
    await start();
    await advance(10_000);
    stops.forEach((stop) => stop());
    expect(vi.getTimerCount()).toBe(0);
    expect(onlineAdd.mock.calls.filter(([name]) => name === "online")).toHaveLength(0);
    expect(visibleAdd.mock.calls.filter(([name]) => name === "visibilitychange")).toHaveLength(0);
    expect(onlineRemove.mock.calls.filter(([name]) => name === "online")).toHaveLength(0);
    expect(visibleRemove.mock.calls.filter(([name]) => name === "visibilitychange")).toHaveLength(0);
  });

  it("warns with the original error when update discovery fails", async () => {
    const error = new Error("check failed");
    mocks.check.mockRejectedValueOnce(error);
    await updater.runUpdateCheck();
    expect(console.warn).toHaveBeenCalledWith("[updater] Update check failed", error);
  });

  it("warns with the original error when installation or relaunch fails", async () => {
    const error = new Error("restart failed");
    mocks.relaunch.mockRejectedValueOnce(error);
    await discover();
    await updater.installAvailableUpdate();
    expect(console.warn).toHaveBeenCalledWith("[updater] Update installation or restart failed", error);
  });
});

describe("settings confirmation", () => {
  it("discovers without installing, shares the warning and mark, then installs on confirmation", async () => {
    await mount(createElement(Fragment, null,
      createElement(AppInfoTab), createElement(UpdateButton, { testProfile: null })));
    await click("更新を確認");
    expect(mocks.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(host.textContent).toContain(warning);
    expect(host.textContent).toContain("v1.0.0 → v1.1.0");
    expect(mark()).not.toBeNull();
    await click("更新して再起動");
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("still says the installed version is current", async () => {
    mocks.check.mockResolvedValue(null);
    await mount(createElement(AppInfoTab));
    await click("更新を確認");
    expect(host.textContent).toContain("最新版です");
    expect(host.textContent).not.toContain(warning);
  });

  it("hides the confirmation when an open settings dialog loses the role", async () => {
    await mount(createElement(AppInfoTab));
    await click("更新を確認");
    expect(button("更新して再起動")).toBeDefined();
    await act(async () => context.setWindowRole(false));
    expect([...host.querySelectorAll("button")]).toHaveLength(0);
  });
});
