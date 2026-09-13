import { beforeEach, describe, expect, it, vi } from "vitest";

const label = vi.fn(() => "main");

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    get label() {
      return label();
    },
  }),
}));

import {
  hasWindowRole,
  setWindowRole,
  subscribeWindowRole,
  isChildWindow,
  isMainWindow,
  resetWindowContextCacheForTests,
  windowLabel,
} from "../../src/lib/windowContext";

describe("windowContext", () => {
  beforeEach(() => {
    resetWindowContextCacheForTests();
    label.mockReset();
    label.mockReturnValue("main");
  });

  it("reports the main window", () => {
    expect(windowLabel()).toBe("main");
    expect(isMainWindow()).toBe(true);
    expect(isChildWindow()).toBe(false);
  });

  it("reports child windows", () => {
    label.mockReturnValue("mycmux-w1");
    expect(windowLabel()).toBe("mycmux-w1");
    expect(isMainWindow()).toBe(false);
    expect(isChildWindow()).toBe(true);
  });

  it("resolves the label exactly once", () => {
    windowLabel();
    windowLabel();
    isMainWindow();
    expect(label).toHaveBeenCalledTimes(1);
  });

  it("falls back to main outside a Tauri webview", () => {
    label.mockImplementation(() => {
      throw new Error("no __TAURI_INTERNALS__");
    });
    expect(windowLabel()).toBe("main");
    expect(isMainWindow()).toBe(true);
  });
});

describe("transferable window role", () => {
  beforeEach(() => setWindowRole(false));

  it("notifies consumers only when ownership changes and stops after unsubscribe", () => {
    const notify = vi.fn();
    const stop = subscribeWindowRole(notify);
    expect(hasWindowRole()).toBe(false);
    setWindowRole(true);
    expect(hasWindowRole()).toBe(true);
    setWindowRole(true);
    expect(notify).toHaveBeenCalledTimes(1);
    setWindowRole(false);
    expect(notify).toHaveBeenCalledTimes(2);
    stop();
    setWindowRole(true);
    expect(notify).toHaveBeenCalledTimes(2);
    setWindowRole(false);
  });

  it("does not reinterpret the window label when the role moves", () => {
    resetWindowContextCacheForTests();
    label.mockReturnValue("mycmux-w2");
    setWindowRole(true);
    expect(hasWindowRole()).toBe(true);
    expect(isMainWindow()).toBe(false);
    expect(windowLabel()).toBe("mycmux-w2");
    setWindowRole(false);
  });
});
