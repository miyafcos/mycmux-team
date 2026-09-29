from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_tab_strip_reorder_dom_contract_spans_component_and_hook() -> None:
    """The reorder hit-test lives in the hook but reads markup owned by
    PaneTabBar. Nothing else fails if those two drift apart, so pin the pair."""
    tab_bar = read("src/components/workspace/PaneTabBar.tsx")
    drag_hook = read("src/hooks/usePaneDragSource.ts")
    layout_store = read("src/stores/workspaceLayoutStore.ts")

    assert "data-pane-tab-strip={pane.id}" in tab_bar
    assert "data-tab-id={tab.id}" in tab_bar
    assert 'className="pane-tab-drop-indicator"' in tab_bar

    assert 'closest<HTMLElement>("[data-pane-tab-strip]")' in drag_hook
    assert 'querySelectorAll<HTMLElement>("[data-tab-id]")' in drag_hook
    assert "layoutStore.reorderPaneTab(" in drag_hook

    assert "reorderPaneTab: (workspaceId, paneId, tabId, insertIndex) => {" in layout_store
