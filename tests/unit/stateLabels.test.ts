import { describe, expect, it } from "vitest";
import { stateLabels, stateLabelsForAxes, type ActivityState, type AttentionState } from "../../src/components/dashboard/stateLabels";

describe("stateLabels", () => {
  it("maps legacy state into the two-axis priority vocabulary", () => {
    expect(stateLabels("needsHuman")).toMatchObject({ attention: "needsAnswer", activity: "waiting", primary: "要回答" });
    expect(stateLabels("noUpdate")).toMatchObject({ attention: "needsReview", activity: "stalled", primary: "要確認" });
    expect(stateLabels("error")).toMatchObject({ attention: "needsReview", activity: "error", primary: "要確認" });
  });

  it("uses the activity label when no attention state exists", () => {
    expect(stateLabels("running")).toMatchObject({ attention: null, activity: "working", primary: "作業中" });
    expect(stateLabels("done")).toMatchObject({ attention: "needsReview", activity: "done", primary: "要確認" });
    expect(stateLabels("idle")).toMatchObject({ attention: null, activity: "waiting", primary: "待機" });
    expect(stateLabels("stopped")).toMatchObject({ attention: null, activity: "stopped", primary: "停止" });
  });

  it.each([
    ["needsAnswer", "error", "needsAnswer", "要回答"],
    ["needsReview", "error", "needsReview", "要確認"],
    [null, "error", "error", "エラー"],
    [null, "stalled", "stalled", "出力なし"],
    [null, "working", "working", "作業中"],
    [null, "done", "done", "完了"],
    [null, "waiting", "waiting", "待機"],
    [null, "stopped", "stopped", "停止"],
  ] satisfies Array<[AttentionState, ActivityState, string, string]>) (
    "applies the full priority step %s/%s",
    (attention, activity, primaryKind, primary) => {
      expect(stateLabelsForAxes(attention, activity)).toMatchObject({
        attention,
        activity,
        primaryKind,
        primary,
      });
    },
  );
});
