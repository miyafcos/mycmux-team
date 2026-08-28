import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetGroupingRuntimeForTests,
  endGroupingOperation,
  runLayoutTransition,
  subscribeGroupingFocusIntents,
  tryBeginGroupingOperation,
  useGroupingRuntimeStore,
} from "../../src/stores/groupingRuntimeStore";
import { useUiStore } from "../../src/stores/uiStore";

beforeEach(() => __resetGroupingRuntimeForTests());

describe("grouping runtime listener safety", () => {
  it("compensates an acquire notification throw without replacing the original error", () => {
    const primary = new Error("acquire-listener-primary");
    const unsubscribe = useGroupingRuntimeStore.subscribe((state, previous) => {
      if (previous.operation === null && state.operation !== null) throw primary;
    });

    expect(() => tryBeginGroupingOperation("commit")).toThrow(primary);
    expect(useGroupingRuntimeStore.getState().operation).toBeNull();
    unsubscribe();
    const next = tryBeginGroupingOperation("commit");
    expect(next).not.toBeNull();
    endGroupingOperation(next!);
  });

  it("compensates an enter notification throw and leaves no transition frame", () => {
    const primary = new Error("enter-listener-primary");
    const unsubscribe = useGroupingRuntimeStore.subscribe((state, previous) => {
      if (previous.transitionDepth === 0 && state.transitionDepth === 1) throw primary;
    });

    expect(() => runLayoutTransition("grouping-commit", () => 1)).toThrow(primary);
    expect(useGroupingRuntimeStore.getState()).toMatchObject({
      transitionDepth: 0,
      transitionSource: null,
      transitionFrames: [],
    });
    unsubscribe();
  });

  it("releases the exact exit frame and preserves a body error over cleanup errors", () => {
    const body = new Error("body-primary");
    const unsubscribe = useGroupingRuntimeStore.subscribe((state, previous) => {
      if (previous.transitionDepth === 1 && state.transitionDepth === 0) {
        throw new Error("exit-cleanup-secondary");
      }
    });

    expect(() => runLayoutTransition("grouping-commit", () => {
      throw body;
    })).toThrow(body);
    expect(useGroupingRuntimeStore.getState()).toMatchObject({
      transitionDepth: 0,
      transitionSource: null,
      transitionFrames: [],
    });
    unsubscribe();
  });

  it("rejects Promise and structural thenable results at runtime", () => {
    expect(() => runLayoutTransition("grouping-commit", (() => Promise.resolve(1)) as () => number))
      .toThrow(/thenable|Promise|同期/);
    expect(() => runLayoutTransition("grouping-commit", (() => ({ then() {} })) as () => number))
      .toThrow(/thenable|Promise|同期/);
    expect(useGroupingRuntimeStore.getState()).toMatchObject({ transitionDepth: 0, transitionFrames: [] });
  });

  it("publishes one final focus intent after the outer transition and nested changes", () => {
    const intents: Array<{ activeSessionId: string | null; transitionEpoch: number }> = [];
    const unsubscribe = subscribeGroupingFocusIntents((intent) => intents.push(intent));
    runLayoutTransition("grouping-commit", () => {
      useUiStore.setState({ activePaneId: "intermediate" });
      runLayoutTransition("grouping-commit", () => {
        useUiStore.setState({ activePaneId: "final" });
        expect(intents).toEqual([]);
      });
      expect(intents).toEqual([]);
    });
    expect(intents).toEqual([{
      activeSessionId: "final",
      transitionEpoch: useGroupingRuntimeStore.getState().transitionEpoch,
      intentSequence: 1,
    }]);
    unsubscribe();
    runLayoutTransition("grouping-commit", () => useUiStore.setState({ activePaneId: "after-dispose" }));
    expect(intents).toHaveLength(1);
  });

  it("coalesces focus until operation end and isolates coordinator failures", () => {
    const intents: string[] = [];
    subscribeGroupingFocusIntents(() => { throw new Error("focus execution failed"); });
    subscribeGroupingFocusIntents((intent) => intents.push(intent.activeSessionId ?? "null"));
    const token = tryBeginGroupingOperation("commit");
    expect(token).not.toBeNull();
    runLayoutTransition("grouping-commit", () => useUiStore.setState({ activePaneId: "temporary" }));
    runLayoutTransition("grouping-rollback", () => useUiStore.setState({ activePaneId: null }));
    expect(intents).toEqual([]);
    expect(() => endGroupingOperation(token!)).not.toThrow();
    expect(intents).toEqual(["null"]);
    expect(useGroupingRuntimeStore.getState()).toMatchObject({ operation: null, transitionDepth: 0 });
  });
});
