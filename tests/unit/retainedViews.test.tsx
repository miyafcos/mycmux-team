// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { retainViews, useRetainedViews } from "../../src/lib/retainedViews";
import { TerminalRendererBudget } from "../../src/components/terminal/terminalRendererBudget";

describe("retained terminal views", () => {
  it("does not start unvisited sessions, prunes closed sessions and evicts by cost", () => {
    const views = [{ id: "a", cost: 6 }, { id: "b", cost: 4 }, { id: "c", cost: 6 }];
    expect(retainViews([], ["a"], views, 2, 12)).toEqual(["a"]);
    expect(retainViews(["a"], ["b"], views, 2, 12)).toEqual(["a", "b"]);
    expect(retainViews(["a", "b"], ["c"], views, 2, 12)).toEqual(["b", "c"]);
    expect(retainViews(["a", "b"], ["c"], views.filter(v => v.id !== "b"), 2, 10)).toEqual(["c"]);
    expect(retainViews(["a", "b"], ["c"], views, 2, 8)).toEqual(["c"]);
  });

  it("switches a visited pair without remounts and cleans up observers on eviction/close", () => {
    const mounted = vi.fn(), disposed = vi.fn();
    const observers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
    function FakeTerminal({ id }: { id: string }) {
      useEffect(() => {
        const observer = { disconnect: vi.fn() };
        observers.push(observer); mounted(id);
        return () => { observer.disconnect(); disposed(id); };
      }, [id]);
      return <div data-terminal={id} />;
    }
    function View({ active, ids }: { active: string; ids: string[] }) {
      const retained = useRetainedViews([active], ids.map(id => ({ id, cost: 1 })), 2, 2);
      return retained.map(id => <FakeTerminal key={id} id={id} />);
    }
    const host = document.createElement("div"), root = createRoot(host);
    const render = (active: string, ids = ["a", "b", "c"]) => act(() => root.render(<View active={active} ids={ids} />));
    render("a"); render("b");
    for (let i = 0; i < 20; i++) { render("a"); render("b"); }
    expect(mounted.mock.calls).toEqual([["a"], ["b"]]);
    expect(disposed).not.toHaveBeenCalled();
    render("c");
    expect(disposed.mock.calls).toEqual([["a"]]);
    render("c", ["c"]);
    expect(disposed.mock.calls).toEqual([["a"], ["b"]]);
    act(() => root.unmount());
    expect(disposed.mock.calls).toEqual([["a"], ["b"], ["c"]]);
    expect(observers).toHaveLength(3);
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("terminal renderer budget", () => {
  it("reuses contexts, disposes the LRU before allocation, and forgets closed terminals", () => {
    const budget = new TerminalRendererBudget<object>(2);
    const a = {}, b = {}, c = {};
    const releaseA = vi.fn(), releaseB = vi.fn(), releaseC = vi.fn();
    budget.reserve(a, releaseA); budget.reserve(b, releaseB);
    for (let i = 0; i < 300; i++) { budget.touch(a); budget.touch(b); }
    expect(releaseA).not.toHaveBeenCalled(); expect(releaseB).not.toHaveBeenCalled();
    budget.touch(a); budget.reserve(c, releaseC);
    expect(releaseB).toHaveBeenCalledTimes(1);
    budget.forget(a); budget.reserve({}, vi.fn());
    expect(releaseA).not.toHaveBeenCalled(); expect(releaseC).not.toHaveBeenCalled();
  });
});
