import { describe, expect, it } from "vitest";
import { getTabDisplayLabel } from "../../src/lib/tabDisplayLabel";

describe("pane display priority", () => {
  const tab = { label: "toolx-test-1", labelSource: "ai" as const, displayName: "検査", sessionId: "s", cwd: "C:\\toolx\\work", agentId: "shell-starter" };
  const volatile = { s: { processTitle: "process" } };
  it("prioritizes user labels, then display names, control labels, process and folder", () => {
    expect(getTabDisplayLabel({ ...tab, labelSource: "user" }, true, {}, volatile)).toBe("toolx-test-1");
    expect(getTabDisplayLabel(tab, true, {}, volatile)).toBe("検査");
    expect(getTabDisplayLabel({ ...tab, displayName: undefined }, true, {}, volatile)).toBe("toolx-test-1");
    expect(getTabDisplayLabel({ ...tab, label: undefined, displayName: undefined }, true, {}, volatile)).toBe("process");
    expect(getTabDisplayLabel({ ...tab, label: "", displayName: undefined })).toBe("work");
    expect(getTabDisplayLabel({ ...tab, label: undefined, displayName: undefined }, false)).toBe("work");
  });
  it("never changes input control fields", () => {
    const before = structuredClone(tab);
    getTabDisplayLabel(tab);
    expect(tab).toEqual(before);
  });
});
