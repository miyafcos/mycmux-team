// @vitest-environment jsdom
import { vi } from "vitest";
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Windows" });
});
import "./fixtures/detachedDashboardFocusSuite";
