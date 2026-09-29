import { describe, expect, it } from "vitest";
import { agentCloseDialogOptions } from "../../src/lib/agentCloseDialog";

describe("agentCloseDialogOptions", () => {
  it("uses the shared warning labels for live-agent close confirmation", () => {
    expect(agentCloseDialogOptions("mycmux を終了")).toEqual({
      title: "mycmux を終了",
      kind: "warning",
      okLabel: "終了",
      cancelLabel: "キャンセル",
    });
  });
});
