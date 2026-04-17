import { invoke } from "@tauri-apps/api/core";
import { getTerminalBufferLines } from "../../components/terminal/XTermWrapper";
import { type PaneMetadata, usePaneMetadataStore } from "../../stores/paneMetadataStoreCompat";
import { useUiStore } from "../../stores/uiStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import type { Pane } from "../../types";

const FOCUS_BUFFER_LINES = 30;
const ENTOURAGE_BUFFER_LINES = 3;
const FOCUS_JSONL_TURNS = 6;
const ENTOURAGE_PANE_LIMIT = 10;

export interface WorkspaceContextOptions {
  sensitiveSuppress?: boolean;
}

export async function buildWorkspaceContextText(
  options: WorkspaceContextOptions = {},
): Promise<string> {
  try {
    const workspace = useWorkspaceListStore.getState().getActiveWorkspace();
    if (!workspace || workspace.panes.length === 0) {
      return "";
    }

    const activeSessionId = useUiStore.getState().activePaneId;
    const metadataMap = usePaneMetadataStore.getState().metadata;

    const panes = workspace.panes;
    const focusIndex = activeSessionId
      ? panes.findIndex((pane) => pane.sessionId === activeSessionId)
      : -1;

    const paneLabel = (index: number, pane: Pane): string => {
      if (pane.label && pane.label.trim()) return pane.label.trim();
      return `ターミナル${toCircledNumber(index + 1)}`;
    };

    const lines: string[] = [];
    lines.push("## 同時に動かしてる作業");
    lines.push(
      `いま合計 ${panes.length} 個のターミナルを開いている。1 つは今この会話を打っているターミナル、残りはその脇で走らせている別の作業。脇の作業は横目で把握するだけ。必要なときだけ「○○の方」と軽く触れる。`,
    );
    lines.push("");

    if (focusIndex >= 0) {
      const focusPane = panes[focusIndex];
      const focusSection = await renderFocusPane(
        focusPane,
        paneLabel(focusIndex, focusPane),
        metadataMap[focusPane.sessionId],
        options.sensitiveSuppress === true,
      );
      lines.push(focusSection);
      lines.push("");
    } else {
      lines.push("### ● 今この作業: 特定不可 (active 情報なし)");
      lines.push("");
    }

    const entouragePanes = panes.filter((_, idx) => idx !== focusIndex);
    const entourageSection = renderEntourage(entouragePanes, focusIndex, paneLabel, metadataMap);
    lines.push(entourageSection);

    return lines.join("\n").trimEnd();
  } catch (error) {
    console.warn("[buddy] workspace context build failed:", error);
    return "";
  }
}

async function renderFocusPane(
  pane: Pane,
  label: string,
  metadata: PaneMetadata | undefined,
  sensitiveSuppress: boolean,
): Promise<string> {
  const meta = metadata ?? {};
  const header = [
    `### ● 今この作業 (内部ラベル: ${label} — 発話では使わない)`,
    [
      meta.cwd ? `場所: ${meta.cwd}` : null,
      meta.gitBranch ? `branch: ${meta.gitBranch}` : null,
      meta.processTitle ? `走ってるコマンド: ${meta.processTitle}` : null,
      meta.agentStatus ? `状態: ${meta.agentStatus}` : null,
    ]
      .filter(Boolean)
      .join(" / "),
  ]
    .filter(Boolean)
    .join("\n");

  if (sensitiveSuppress) {
    return `${header}\n(機密入力中: buffer と jsonl は非開示)`;
  }

  const bufferLines = safeGetBuffer(pane.sessionId, FOCUS_BUFFER_LINES);
  const bufferBlock =
    bufferLines.length > 0
      ? `直近のターミナル表示 (${bufferLines.length}行):\n${bufferLines.join("\n")}`
      : "直近のターミナル表示: (空)";

  const sessionId = meta.claudeSessionId ?? pane.claudeSessionId;
  const cwd = meta.cwd ?? pane.cwd ?? "";
  let jsonlBlock = "";
  if (sessionId && cwd) {
    try {
      const tail = await invoke<string>("load_session_tail", {
        sessionId,
        cwd,
        maxTurns: FOCUS_JSONL_TURNS,
      });
      if (typeof tail === "string" && tail.trim().length > 0) {
        jsonlBlock = `直近 Claude 会話 (最大 ${FOCUS_JSONL_TURNS} turn):\n${tail.trim()}`;
      }
    } catch (error) {
      console.warn("[buddy] load_session_tail failed:", error);
    }
  }

  return [header, bufferBlock, jsonlBlock].filter((s) => s && s.length > 0).join("\n\n");
}

function renderEntourage(
  entouragePanes: Pane[],
  focusIndex: number,
  paneLabel: (index: number, pane: Pane) => string,
  metadataMap: Record<string, PaneMetadata>,
): string {
  if (entouragePanes.length === 0) {
    return "### 脇で走らせてる作業: なし";
  }

  const visible = entouragePanes.slice(0, ENTOURAGE_PANE_LIMIT);
  const lines: string[] = [];
  lines.push(`### 脇で走らせてる作業 (${entouragePanes.length}件)`);

  for (const pane of visible) {
    const originalIndex = indexOfPane(pane, focusIndex, entouragePanes);
    const label = paneLabel(originalIndex, pane);
    const meta = metadataMap[pane.sessionId] ?? {};
    const status = meta.agentStatus ?? "idle";
    const proc = meta.processTitle ?? "unknown";
    const cwdShort = shortenCwd(meta.cwd ?? pane.cwd ?? "");
    const header = `- ${label} [${status}] ${proc}${cwdShort ? ` @ ${cwdShort}` : ""}${
      status === "waiting" ? "  ← 承認待ちで止まってる" : ""
    }`;
    lines.push(header);

    const buf = safeGetBuffer(pane.sessionId, ENTOURAGE_BUFFER_LINES);
    if (buf.length > 0) {
      for (const line of buf) {
        lines.push(`    ${truncateLine(line, 120)}`);
      }
    } else if (meta.lastLogLine) {
      lines.push(`    ${truncateLine(meta.lastLogLine, 120)}`);
    }
  }

  if (entouragePanes.length > ENTOURAGE_PANE_LIMIT) {
    lines.push(`- (他 ${entouragePanes.length - ENTOURAGE_PANE_LIMIT} 件は省略)`);
  }

  return lines.join("\n");
}

const CIRCLED_NUMERALS = [
  "", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨",
  "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
];

function toCircledNumber(n: number): string {
  if (n >= 1 && n < CIRCLED_NUMERALS.length) return CIRCLED_NUMERALS[n];
  return `(${n})`;
}

function indexOfPane(pane: Pane, focusIndex: number, entourage: Pane[]): number {
  // restore absolute pane index by summing the focus offset
  const idxInEntourage = entourage.indexOf(pane);
  if (focusIndex < 0) return idxInEntourage;
  return idxInEntourage < focusIndex ? idxInEntourage : idxInEntourage + 1;
}

function safeGetBuffer(sessionId: string, maxLines: number): string[] {
  try {
    return getTerminalBufferLines(sessionId, maxLines);
  } catch {
    return [];
  }
}

function shortenCwd(cwd: string): string {
  if (!cwd) return "";
  const home = detectHome();
  if (home && cwd.startsWith(home)) {
    return "~" + cwd.slice(home.length).replace(/\\/g, "/");
  }
  return cwd.replace(/\\/g, "/");
}

let detectedHome: string | null = null;
function detectHome(): string | null {
  if (detectedHome !== null) return detectedHome;
  // Best-effort: inspect any pane cwd that begins with "C:\Users\" prefix
  const workspace = useWorkspaceListStore.getState().getActiveWorkspace();
  if (workspace) {
    for (const pane of workspace.panes) {
      const cwd = pane.cwd ?? "";
      const match = cwd.match(/^([A-Z]:\\Users\\[^\\]+)/i);
      if (match) {
        detectedHome = match[1];
        return detectedHome;
      }
    }
  }
  detectedHome = "";
  return null;
}

function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + "…";
}
