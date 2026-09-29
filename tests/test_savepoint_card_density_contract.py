from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_savepoint_cards_bound_text_growth_in_narrow_panes():
    panel = read("src/components/online/OnlinePanel.tsx")

    assert 'className="online-savepoint-list"' in panel
    assert ".online-savepoint-list {\n  container-type: inline-size;" in panel
    assert 'className="online-sp-card-project"' in panel
    assert 'className="online-sp-card-owner"' in panel
    assert 'className="online-sp-card-summary"' in panel
    assert "-webkit-line-clamp: 2;" in panel
    assert "@container (max-width: 340px)" in panel
    assert 'className="online-panel-heading"' in panel
    assert panel.count('className="online-toolbar-button"') == 2
    assert 'className="online-toolbar-button-label"' in panel
    assert ".online-toolbar-button-icon {\n  display: none;" in panel
    assert ".online-toolbar-button-label {\n    display: none;" in panel
    narrow_rules = panel.split("@container (max-width: 340px)", 1)[1].split("}", 3)
    assert any("-webkit-line-clamp: 1;" in rule for rule in narrow_rules)
    assert any("display: none;" in rule for rule in narrow_rules)
    assert 'padding: "8px 9px"' in panel
    assert 'list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }' in panel
    assert 'flexWrap: "nowrap"' in panel
    assert 'textOverflow: "ellipsis"' in panel
    assert 'whiteSpace: "nowrap"' in panel


def test_savepoint_details_and_large_actions_are_disclosed_one_card_at_a_time():
    panel = read("src/components/online/OnlinePanel.tsx")
    strings = read("src/components/online/onlineStrings.ts")

    assert "const expanded = selectedBundle === entry.bundle_dir;" in panel
    assert "setSelectedBundle(expanded ? null : entry.bundle_dir)" in panel
    assert "aria-expanded={expanded}" in panel
    assert "aria-controls={detailsId}" in panel
    assert 'className="online-sp-card-disclosure"' in panel
    assert 'className="online-sp-card-details"' in panel
    assert "{expanded && (" in panel
    expanded_section = panel.split("{expanded && (", 1)[1].split("</article>", 1)[0]
    assert "trashed ? (" in expanded_section
    assert 'handoffSummary(entry, "claude")' in expanded_section
    assert 'handoffSummary(entry, "codex")' in expanded_section
    assert "shareTransfer(entry)" in expanded_section
    assert "restoreEntry(entry)" in expanded_section
    assert "purgeEntry(entry)" in expanded_section
    assert 'expandCardDetails: "詳細を表示"' in strings
    assert 'collapseCardDetails: "詳細を閉じる"' in strings
    assert 'data-savepoint-export-target="true"' in panel
    assert "if (!dragging) return null;" in panel


def test_compact_controls_preserve_drag_and_trash_boundaries():
    panel = read("src/components/online/OnlinePanel.tsx")
    drag_hook = read("src/hooks/useSavepointDragSource.ts")

    assert 'data-savepoint-drag-handle="true"' in panel
    assert 'onPointerDown={trashed ? undefined' in panel
    assert 'data-dnd-ignore="true"' in panel
    assert 'targetElement.closest("button, input, textarea, select, [data-dnd-ignore=\'true\']")' in drag_hook
