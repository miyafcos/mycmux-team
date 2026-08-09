import { useCallback, useState } from "react";
import type { SVGProps } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createWorkspaceAtCwd,
  workspaceNameFromCwd,
  type EmptyWorkspaceVariant,
} from "../../lib/workspaceBootstrap";
import { useKeybindingStore } from "../../stores/keybindingStore";
import { formatShortcutLabel } from "../../lib/keybindings";
import { useToastStore } from "../../stores/toastStore";

// UI strings live here (setup surfaces keep their copy inline — see WorkspaceSetup).
const strings = {
  wordmark: "mycmux",
  firstRunTitle: "mycmux へようこそ",
  firstRunBody: "ワークスペースを作るとターミナルが開きます。まずは作業フォルダを決めてください。",
  returningTitle: "ワークスペースがありません",
  returningBody: "開いているワークスペースはありません。下のどれかから再開できます。",
  homeAction: "ホームで新規ワークスペース",
  homeActionHint: "ホームフォルダで 1 ペインのターミナルを開きます",
  folderAction: "フォルダを選んで開始",
  folderActionHint: "選んだフォルダを作業ディレクトリにします",
  folderDialogTitle: "ワークスペースの作業フォルダを選択",
  advancedAction: "詳しく設定して作成",
  shortcutHintPrefix: "いつでも ",
  shortcutHintSuffix: " で新規ワークスペースを作成できます",
  homeError: "ホームフォルダを取得できませんでした。設定画面から作成してください。",
  folderError: "フォルダを選択できませんでした。設定画面から作成してください。",
} as const;

type PendingAction = "home" | "folder" | null;

interface EmptyWorkspaceStateProps {
  variant: EmptyWorkspaceVariant;
  /** Opens the full WorkspaceSetup modal (grid + agent assignment). */
  onOpenSetup: () => void;
}

const iconProps = (size: number): SVGProps<SVGSVGElement> => ({
  "aria-hidden": true,
  focusable: "false",
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

function TerminalGlyph({ size = 28 }: { size?: number }) {
  return (
    <svg {...iconProps(size)}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7.5 10 2.5 2-2.5 2" />
      <path d="M12.5 14.5h4" />
    </svg>
  );
}

function HomeGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...iconProps(size)}>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.8V20h12V9.8" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

function FolderGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg {...iconProps(size)}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5Z" />
    </svg>
  );
}

export default function EmptyWorkspaceState({ variant, onOpenSetup }: EmptyWorkspaceStateProps) {
  const [pending, setPending] = useState<PendingAction>(null);
  const newWorkspaceShortcut = useKeybindingStore((state) => state.keybindings["workspace.new"]);
  const pushToast = useToastStore((state) => state.pushToast);

  const startInHome = useCallback(async () => {
    if (pending) return;
    setPending("home");
    try {
      const home = await homeDir();
      createWorkspaceAtCwd(home, { name: workspaceNameFromCwd(home) });
    } catch (error) {
      console.error("[empty-state] failed to resolve home directory", error);
      pushToast(strings.homeError, "error");
      onOpenSetup();
    } finally {
      setPending(null);
    }
  }, [onOpenSetup, pending, pushToast]);

  const startInPickedFolder = useCallback(async () => {
    if (pending) return;
    setPending("folder");
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: strings.folderDialogTitle,
      });
      // null = user cancelled; stay on the panel instead of creating anything.
      if (typeof picked !== "string" || picked.length === 0) return;
      createWorkspaceAtCwd(picked, { name: workspaceNameFromCwd(picked) });
    } catch (error) {
      console.error("[empty-state] folder picker failed", error);
      pushToast(strings.folderError, "error");
      onOpenSetup();
    } finally {
      setPending(null);
    }
  }, [onOpenSetup, pending, pushToast]);

  const title = variant === "first-run" ? strings.firstRunTitle : strings.returningTitle;
  const body = variant === "first-run" ? strings.firstRunBody : strings.returningBody;

  return (
    <div
      className="cmux-empty-workspace"
      data-empty-workspace-variant={variant}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
        background: "var(--cmux-bg)",
        overflow: "auto",
      }}
    >
      <style>{emptyWorkspaceCss}</style>
      <section
        aria-label={title}
        className="cmux-empty-workspace-card"
        style={{
          width: "100%",
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
          textAlign: "center",
        }}
      >
        <div
          className="cmux-empty-workspace-mark"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--cmux-text-secondary)",
          }}
        >
          <TerminalGlyph />
          <span
            style={{
              fontFamily: "var(--cmux-font-mono)",
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "0.04em",
              color: "var(--cmux-text)",
            }}
          >
            {strings.wordmark}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              color: "var(--cmux-text)",
              fontFamily: "var(--cmux-font-mono)",
            }}
          >
            {title}
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: "var(--cmux-font-size-md)",
              lineHeight: 1.7,
              color: "var(--cmux-text-secondary)",
            }}
          >
            {body}
          </p>
        </div>

        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="cmux-empty-action cmux-empty-action--primary"
            onClick={() => void startInHome()}
            disabled={pending !== null}
            title={strings.homeActionHint}
          >
            <HomeGlyph />
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{strings.homeAction}</span>
              <span className="cmux-empty-action-hint">{strings.homeActionHint}</span>
            </span>
          </button>

          <button
            className="cmux-empty-action"
            onClick={() => void startInPickedFolder()}
            disabled={pending !== null}
            title={strings.folderActionHint}
          >
            <FolderGlyph />
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{strings.folderAction}</span>
              <span className="cmux-empty-action-hint">{strings.folderActionHint}</span>
            </span>
          </button>

          <button
            className="cmux-empty-action cmux-empty-action--quiet"
            onClick={onOpenSetup}
            disabled={pending !== null}
          >
            {strings.advancedAction}
          </button>
        </div>

        <p
          style={{
            margin: 0,
            fontSize: "var(--cmux-font-size-xs)",
            color: "var(--cmux-text-tertiary)",
          }}
        >
          {strings.shortcutHintPrefix}
          <kbd
            style={{
              fontFamily: "var(--cmux-font-mono)",
              border: "1px solid var(--cmux-border)",
              borderRadius: 4,
              padding: "1px 5px",
              color: "var(--cmux-text-secondary)",
            }}
          >
            {formatShortcutLabel(newWorkspaceShortcut)}
          </kbd>
          {strings.shortcutHintSuffix}
        </p>
      </section>
    </div>
  );
}

// Entry motion and hover/disabled states need real CSS; everything else stays in
// the inline style objects above. The global prefers-reduced-motion rule in
// global.css neutralizes these animations automatically.
const emptyWorkspaceCss = `
.cmux-empty-workspace-card {
  animation: cmux-empty-workspace-in var(--cmux-motion-slow) var(--cmux-ease);
}
@keyframes cmux-empty-workspace-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.cmux-empty-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid var(--cmux-border);
  background: var(--cmux-surface);
  color: var(--cmux-text);
  font-size: var(--cmux-font-size-md);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--cmux-motion-fast) var(--cmux-ease),
    border-color var(--cmux-motion-fast) var(--cmux-ease),
    transform var(--cmux-motion-fast) var(--cmux-ease);
}
.cmux-empty-action:hover:not(:disabled) {
  background: var(--cmux-hover);
  border-color: color-mix(in srgb, var(--cmux-accent) 40%, var(--cmux-border));
}
.cmux-empty-action:active:not(:disabled) {
  transform: scale(0.99);
}
.cmux-empty-action:disabled {
  opacity: 0.55;
  cursor: default;
}
.cmux-empty-action--primary {
  border-color: color-mix(in srgb, var(--cmux-accent) 55%, var(--cmux-border));
  background: color-mix(in srgb, var(--cmux-accent) 14%, var(--cmux-surface));
}
.cmux-empty-action--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--cmux-accent) 22%, var(--cmux-surface));
}
.cmux-empty-action--quiet {
  justify-content: center;
  background: transparent;
  border-color: transparent;
  color: var(--cmux-text-secondary);
  font-size: var(--cmux-font-size-sm);
}
.cmux-empty-action--quiet:hover:not(:disabled) {
  background: var(--cmux-hover);
  border-color: var(--cmux-border);
  color: var(--cmux-text);
}
.cmux-empty-action-hint {
  font-size: var(--cmux-font-size-xs);
  color: var(--cmux-text-tertiary);
}
`;
