from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_repo_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def assert_contains(text: str, snippet: str, source: str) -> None:
    assert snippet in text, f"Missing snippet in {source}: {snippet}"


def assert_snippets(relative_path: str, snippets: list[str]) -> None:
    text = read_repo_text(relative_path)
    for snippet in snippets:
        assert_contains(text, snippet, relative_path)


def test_file_preview_agent_usage_and_fault_surfaces_remain_wired() -> None:
    assert_snippets(
        "src/components/layout/FileExplorerSidebar.tsx",
        [
            "previewArtifactUriForSessionV2(target.sessionId, path)",
            "useWorkspaceLayoutStore\n      .getState()\n      .openOrReloadHtmlPreviewPane",
            "await openWithDefault(ctx.path);",
            "await revealInExplorer(ctx.path);",
            "if (pendingAction) return;",
            "aria-busy={pendingAction !== null}",
            "setActionError(`Open failed: ${String(err)}`);",
            "contextMenuErrorStyle",
        ],
    )
    assert_snippets(
        "src/stores/workspaceLayoutStore.ts",
        [
            "openOrReloadHtmlPreviewPane: (workspaceId: string, sourcePaneId: string, info: string | BrowserPreviewInfo) => void;",
            "function bumpBrowserTabReloadCounter(tab: PaneTab, info?: Required<BrowserPreviewInfo>): PaneTab {",
            "useUiStore.getState().setActivePaneId(updatedTab.sessionId);",
            "useUiStore.getState().setActivePaneId(openedTab.sessionId);",
        ],
    )
    assert_snippets(
        "src/components/workspace/TerminalPane.tsx",
        [
            "previewArtifactUriForSessionV2(currentTab.sessionId, uri)",
            "const pendingPreviewUriRef = useRef<string | null>(null);",
            "if (pendingPreviewUriRef.current) return;",
            "reportOpenFailure(\"Preview failed and fallback open failed\", openError)",
            "{previewActionError && (",
        ],
    )
