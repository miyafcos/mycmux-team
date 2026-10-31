// @vitest-environment jsdom
import { vi } from "vitest";
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Macintosh" });
});
import "./fixtures/detachedDashboardFocusSuite";
