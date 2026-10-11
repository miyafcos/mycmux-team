from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_active_header_merge_dom_contract_spans_component_and_hook() -> None:
    """The active name stays draggable, while header drops merge and select.
    Body zones and the layout store's independent reorder API stay intact."""
    tab_bar = read("src/components/workspace/PaneTabBar.tsx")
    drag_hook = read("src/hooks/usePaneDragSource.ts")
    layout_store = read("src/stores/workspaceLayoutStore.ts")

    assert "data-pane-tab-strip={pane.id}" in tab_bar
    assert "data-tab-id={tab.id}" in tab_bar
    assert "pane-tab-drop-indicator" not in tab_bar

    assert "resolvePaneHeaderTarget(element)" in drag_hook
    assert "paneHeaderInsertionIndex(pane)" in drag_hook
    assert "selectPaneHeaderTab(target.workspaceId, target.paneId, item.tabId)" in drag_hook
    assert "reorderPaneTab(" not in drag_hook

    assert "reorderPaneTab: (workspaceId, paneId, tabId, insertIndex) => {" in layout_store
