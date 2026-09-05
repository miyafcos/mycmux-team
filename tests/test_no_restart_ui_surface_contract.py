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
            # The shortcut is rendered from the live binding rather than written
            # out, so it follows a rebind and prints the macOS glyphs. The
            # tooltip still has to be there, which is what this pins.
            "title={`New workspace (${newWorkspaceShortcut})`}",
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
    # The flat SettingsMenu popover was replaced by the tabbed SettingsDialog
    # (2026-07-13); the Remote and notification surfaces now live in tab files.
    assert_snippets(
        "src/components/settings/tabs/RemoteTab.tsx",
        [
            "const [remoteInfo, setRemoteInfo] = useState<RemoteInfo | null>(null);",
            "const nextInfo = await rotateRemoteToken();",
            "setRemoteMsg(`token を再生成しました。末尾: ${nextInfo.token_suffix}`);",
            "setRemoteInfo(nextInfo);",
            "remoteInfo.connected_clients.length === 0",
        ],
    )
    assert_snippets(
        "src/components/settings/tabs/NotificationsLayoutTab.tsx",
        [
            "const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);",
            "const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled);",
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


def test_savepoints_and_remote_control_have_separate_settings_destinations() -> None:
    assert_snippets(
        "src/components/settings/SettingsDialog.tsx",
        [
            'import { SavepointsTab } from "./tabs/SavepointsTab";',
            '| "savepoints"',
            '{ id: "savepoints", label: onlineStrings.settingsTabLabel }',
            'label: "接続"',
            '{ id: "remote", label: settingsStrings.remoteTabLabel }',
            "onOpenOnlinePanel: () => void;",
            'activeTab === "savepoints"',
            "onOpenOnlinePanel();",
            'width: "clamp(168px, 16vw, 280px)"',
        ],
    )
    assert_snippets(
        "src/components/settings/tabs/SavepointsTab.tsx",
        [
            "getSavepointStorageSettings",
            "onlineStrings.settingsStorageCurrentLabel",
            "storageSettings?.legacy_directory",
            "onlineStrings.settingsLegacyStorageLabel",
            "onlineStrings.settingsLegacyStorageNote",
            "onlineStrings.settingsStepCurrent",
            "onlineStrings.settingsStepFinal",
            "onlineStrings.settingsStepResume",
            "onlineStrings.settingsSaveMethodsAriaLabel",
            "onlineStrings.settingsSeparationNote",
            "onlineStrings.openPanelLabel",
            "<ul",
            "<li",
        ],
    )
    assert_snippets(
        "src/components/online/onlineStrings.ts",
        [
            'settingsStorageHeading: "このPCの保存先"',
            'settingsStorageCurrentLabel: "ローカル保存先"',
            'settingsStorageReadyOnFirstSave: "最初の保存時に作成します"',
            'settingsLegacyStorageLabel: "以前の保存先"',
            "作業フォルダ全体のバックアップではありません",
            "以前の共有先は変更・削除していません",
        ],
    )
    assert_snippets(
        "src/lib/ipc.ts",
        [
            "export interface SavepointStorageSettings",
            "legacy_directory: string | null;",
            'invoke<SavepointStorageSettings>("get_savepoint_storage_settings")',
        ],
    )
    assert_snippets(
        "src-tauri/src/lib.rs",
        [
            "commands::online::get_savepoint_storage_settings",
            "commands::online::transfer::export_savepoint_transfer",
            "commands::online::transfer::import_savepoint_transfer",
        ],
    )
    assert_snippets(
        "src-tauri/src/commands/online.rs",
        [
            "fn existing_directory_inside_mycmux_home",
                'runtime_dir_from_home(home).join("savepoints")',
            "legacy_directory",
        ],
    )
    assert "setSavepointStorageDirectory" not in read_repo_text(
        "src/components/settings/tabs/SavepointsTab.tsx"
    )
    assert 'invoke("set_savepoint_storage_directory"' not in read_repo_text("src/lib/ipc.ts")
    assert "commands::online::set_savepoint_storage_directory" not in read_repo_text(
        "src-tauri/src/lib.rs"
    )
    assert_snippets(
        "src-tauri/src/commands/online_publish.rs",
        ["pub(crate) static PUBLISH_LOCK"],
    )
    assert_snippets(
        "src/components/layout/TitleBar.tsx",
        [
            "title={onlineStrings.openPanelLabel}",
            "aria-label={onlineStrings.openPanelLabel}",
            "onOpenOnlinePanel={onOpenOnlinePanel}",
        ],
    )
    assert_snippets(
        "src/components/online/OnlinePanel.tsx",
        [
            "{onlineStrings.panelTitle}",
            'view === "active" ? onlineStrings.panelDescription : onlineStrings.trashDescription',
        ],
    )
    assert_snippets(
        "src/components/settings/tabs/RemoteTab.tsx",
        [
            "{settingsStrings.remoteTabLabel}",
            "{settingsStrings.remoteDescription}",
        ],
    )


def test_file_preview_agent_usage_and_fault_surfaces_remain_wired() -> None:
    # PathJumper / fileExplorerStore were deleted with the dead-code sweep:
    # the only renderer of PathJumper was FileExplorerSidebar (removed in
    # b7f0238), so both files had zero reachable callers. Their contracts are
    # replaced by an existence check so the dead surface cannot silently return.
    for removed in (
        "src/components/layout/PathJumper.tsx",
        "src/components/layout/pathJumperWatch.ts",
        "src/stores/fileExplorerStore.ts",
    ):
        assert not (REPO_ROOT / removed).exists(), f"unreachable UI surface returned: {removed}"
    assert_snippets(
        "src/stores/workspaceLayoutStore.ts",
        [
            "openOrReloadHtmlPreviewPane: (workspaceId: string, sourcePaneId: string, info: string | BrowserPreviewInfo) => void;",
            "function bumpBrowserTabReloadCounter(tab: PaneTab, info?: Required<BrowserPreviewInfo>): PaneTab {",
            "applyStructuralActivation(updatedTab.sessionId);",
            "applyStructuralActivation(openedTab.sessionId);",
        ],
    )
    assert_snippets(
        "src/components/workspace/TerminalPane.tsx",
        [
            "const pendingPreviewUriRef = useRef<string | null>(null);",
            "if (pendingPreviewUriRef.current) return;",
            "reportOpenFailure(terminalPaneStrings.previewFallbackFailed, openError)",
            "{previewActionError && (",
        ],
    )
    assert_snippets(
        "src/lib/agents.ts",
        [
            "export const BUILT_IN_AGENTS: AgentDefinition[] = [",
            'name: "Claude Code"',
            'name: "Codex CLI"',
            "export function getDefaultAgent(): AgentDefinition {",
        ],
    )
    assert_snippets(
        "src/components/layout/AccountsButton.tsx",
        [
            "export function AccountsButton({ onOpenUsageSettings }",
            "<AccountsPanel",
            "resolveMeterMode(flags, hasAccountChips)",
        ],
    )
    assert_snippets(
        "src/components/layout/AccountsPanel.tsx",
        [
            "export function AccountsPanel(",
            "{PROVIDER_SHORT[row.provider]}",
            "switchWarningText(",
        ],
    )
    assert_snippets(
        "src-tauri/src/commands/usage.rs",
        [
            "pub async fn get_account_usage(",
            "fn planned_rows(",
            "fn classify_live_identity(",
        ],
    )
    assert_snippets(
        "src/components/common/ErrorBoundary.tsx",
        [
            "export default class ErrorBoundary extends Component<Props, State>",
            "Pane crashed",
        ],
    )
    assert_snippets(
        "src/components/workspace/WorkspaceView.tsx",
        [
            "import ErrorBoundary from \"../common/ErrorBoundary\";",
            "<ErrorBoundary>",
        ],
    )
