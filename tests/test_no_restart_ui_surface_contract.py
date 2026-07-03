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


def test_pane_and_workspace_ui_surfaces_remain_wired() -> None:
    assert_snippets(
        "src/components/layout/TabBar.tsx",
        [
            "const workspaces = useWorkspaceListStore((s) => s.workspaces);",
            "const activeId = useWorkspaceListStore((s) => s.activeWorkspaceId);",
            "const setActive = useWorkspaceListStore((s) => s.setActiveWorkspace);",
            "const reorder = useWorkspaceListStore((s) => s.reorderWorkspaces);",
            "notificationCount={totalWsNotifications || undefined}",
            "onClick={setActive}",
            "onClick={() => { if (!draggingRef.current) onClick(ws.id); }}",
            "onClose={onCloseWorkspace}",
            "onClose={() => onClose(ws.id)}",
            'title="New workspace (Ctrl+Shift+N)"',
        ],
    )
    assert_snippets(
        "src/components/layout/TabItem.tsx",
        [
            "notificationCount?: number;",
            "{notificationCount}",
            'title="Close workspace"',
        ],
    )
    assert_snippets(
        "src/components/workspace/PaneTabBar.tsx",
        [
            'title="New terminal tab"',
            'title="Split right"',
            'title="Split down"',
            'title="Close pane"',
        ],
    )
    assert_snippets(
        "src/components/workspace/TerminalPane.tsx",
        [
            "const addTabToPane = useWorkspaceLayoutStore((s) => s.addTabToPane);",
            "const setActivePaneTab = useWorkspaceLayoutStore((s) => s.setActivePaneTab);",
            "addTabToPane(workspaceId, pane.id, agentId, type);",
            "setActivePaneTab(workspaceId, pane.id, tabId);",
        ],
    )
    assert_snippets(
        "src/stores/workspaceLayoutStore.ts",
        [
            "moveTabToPane: (",
            "moveTabToSplit: (",
            "movePaneToPane: (",
            "movePaneToSplit: (",
            "moveTabToNewWorkspace: (",
            "movePaneToNewWorkspace: (",
        ],
    )


def test_terminal_search_notifications_and_settings_surfaces_remain_wired() -> None:
    assert_snippets(
        "src/components/terminal/XTermWrapper.tsx",
        [
            'import { SearchAddon } from "@xterm/addon-search";',
            "const searchAddon = new SearchAddon();",
            "term.loadAddon(searchAddon);",
            "searchAddonRef.current?.findPrevious(searchQuery);",
            "searchAddonRef.current?.findNext(searchQuery);",
            "useSettingsStore.getState().notificationsEnabled",
        ],
    )
    assert_snippets(
        "src/components/layout/SettingsMenu.tsx",
        [
            "import { getRemoteInfo, rotateRemoteToken, type RemoteInfo } from \"../../lib/ipc\";",
            "const [remoteInfo, setRemoteInfo] = useState<RemoteInfo | null>(null);",
            "const nextInfo = await rotateRemoteToken();",
            "setRemoteMsg(`token を再生成しました。末尾: ${nextInfo.token_suffix}`);",
            "setRemoteInfo(nextInfo);",
            "remoteInfo.connected_clients.length === 0",
            "const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);",
            "const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled);",
            "Terminal renderer (stable DOM)",
            "setNotificationSoundEnabled(e.target.checked)",
        ],
    )
    assert_snippets(
        "src/components/layout/NotificationPanel.tsx",
        [
            "const clearNotification = usePaneMetadataStore((s) => s.clearNotification);",
            "No notifications",
            "clearNotification(n.sessionId);",
        ],
    )


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
