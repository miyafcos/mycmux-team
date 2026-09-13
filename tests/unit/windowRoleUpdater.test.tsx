// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runUpdateCheck: vi.fn(async () => {}),
  invoke: vi.fn(async () => null as string | null),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../src/lib/forcedAutoUpdater", () => ({ runUpdateCheck: mocks.runUpdateCheck }));
import { AppInfoTab } from "../../src/components/settings/tabs/AppInfoTab";
import { setWindowRole } from "../../src/lib/windowContext";

describe("updater follows the live window role", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(null);
    setWindowRole(false);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    setWindowRole(false);
  });
  it("reveals and removes the update action when an already-open dialog gains and loses the role", async () => {
    await act(async () => root.render(createElement(AppInfoTab)));
    expect(host.querySelector("button")).toBeNull();
    await act(async () => setWindowRole(true));
    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(mocks.runUpdateCheck).toHaveBeenCalledOnce();
    await act(async () => setWindowRole(false));
    expect(host.querySelector("button")).toBeNull();
    await act(async () => setWindowRole(true));
    expect(host.querySelector("button")).not.toBeNull();
  });
  it("keeps test-profile updates disabled even for the role owner", async () => {
    mocks.invoke.mockResolvedValue("peer-test");
    setWindowRole(true);
    await act(async () => root.render(createElement(AppInfoTab)));
    expect(host.querySelector("button")).toBeNull();
    expect(mocks.runUpdateCheck).not.toHaveBeenCalled();
  });
});
