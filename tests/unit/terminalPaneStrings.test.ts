import { describe, expect, it } from "vitest";
import { paneToolbarStrings } from "../../src/components/workspace/terminalPaneStrings";

describe("whole-container close label", () => {
  it("describes the displayed tab when nothing is behind it", () => {
    expect(paneToolbarStrings.closePane(0)).toBe("このタブを閉じる");
  });

  it("includes the actual background count", () => {
    expect(paneToolbarStrings.closePane(1)).toBe("このタブと裏のタブ 1 個を閉じる");
    expect(paneToolbarStrings.closePane(7)).toBe("このタブと裏のタブ 7 個を閉じる");
  });
});
