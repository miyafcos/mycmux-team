import { memo, useState, useRef, useCallback, useEffect } from "react";
import type { CSSProperties } from "react";
import { KIND_COLORS } from "../../lib/agentKindColors";
import { ATTENTION_REASON_COLOR, unseenAttentionLabel } from "../../lib/attentionPresentation";
import { resolveWorkspaceColor, workspaceRowBackground } from "../../lib/workspaceColors";
import PetSprite, { type PetSpriteState } from "../workspace/PetSprite";
import type { AttentionCategory } from "../../stores/sessionAttentionStore";
import type { AgentSessionKind } from "../../types";

interface StatusCounts {
  working: number;
  waiting: number;
}

interface TabItemProps {
  uiVariant?: "default" | "cmux";
  name: string;
  paneCount: number;
  cwd?: string;
  gitBranch?: string;
  notificationCount?: number;
  workDoneCount?: number;
  lastLogLine?: string;
  statusCounts?: StatusCounts;
  petState?: PetSpriteState;
  petAtlasUrl?: string;
  showPet?: boolean;
  /**
   * Tabs in this workspace carrying an attention the user has not looked at.
   * Distinct from notificationCount / workDoneCount, which count events rather
   * than unread state, so this gets its own indicator instead of a badge.
   */
  unseenAttentionCount?: number;
  /** Most urgent unseen category, used only to color the indicator. */
  unseenAttentionCategory?: AttentionCategory | null;
  agentKinds?: readonly AgentSessionKind[];
  /** Persisted workspace color (a palette hex) or undefined for no group. */
  color?: string;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  /**
   * Open the workspace menu (color, rename, new window) at the given screen
   * point. Lives on a hover button because right-click is not a reliable
   * gesture here: the native WebView2 menu it used to race is suppressed, and
   * some users disable right-click entirely.
   */
  onMenu?: (x: number, y: number) => void;
  onRename?: (newName: string) => void;
  /**
   * Bumped by the sidebar context menu to open inline rename without the user
   * having to double-click the row a second time.
   */
  renameSignal?: number;
}

const AGENT_KIND_ACCESSIBLE_LABELS: Record<AgentSessionKind, string> = {
  "claude": "Claude",
  "codex": "Codex",
  "claude-codex": "Hybrid",
};

type AgentKindStyle = CSSProperties & { "--agent-kind-color": string };

function StatusPip({ count, color, pulse = false }: { count: number; color: string; pulse?: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span className={`cmux-status-dot${pulse ? " cmux-status-dot--working" : ""}`} style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }} />
      {count > 1 && (
        <span style={{ fontSize: 10, color, fontWeight: 600, lineHeight: 1 }}>{count}</span>
      )}
    </span>
  );
}

// Mirrors the pane tab pill's AttentionUnreadDot: a hollow ring, colored by
// category, so "unseen" reads the same in the sidebar as it does on the pill.
// The count only appears above one, matching StatusPip.
function UnseenAttentionRing({ count, category }: { count: number; category: AttentionCategory }) {
  const color = ATTENTION_REASON_COLOR[category];
  const label = unseenAttentionLabel(category);
  return (
    <span
      className="cmux-badge-pop"
      role="img"
      title={label}
      aria-label={count > 1 ? `${label} ${count}` : label}
      style={{ display: "flex", alignItems: "center", gap: 3 }}
    >
      <span style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        border: `2px solid ${color}`,
        background: "transparent",
        boxSizing: "border-box",
        flexShrink: 0,
      }} />
      {count > 1 && (
        <span style={{ fontSize: 10, color, fontWeight: 600, lineHeight: 1 }}>{count}</span>
      )}
    </span>
  );
}

export default memo(function TabItem({ uiVariant = "default", name, paneCount, cwd, gitBranch, notificationCount, workDoneCount, lastLogLine, statusCounts, petState = "idle", petAtlasUrl, showPet = true, unseenAttentionCount = 0, unseenAttentionCategory = null, agentKinds = [], color, active, onClick, onClose, onMenu, onRename, renameSignal = 0 }: TabItemProps) {
  const hasAgents = statusCounts && (statusCounts.working + statusCounts.waiting) > 0;
  const hasAgentKinds = agentKinds.length > 0;
  const hasUnseenAttention = unseenAttentionCount > 0 && unseenAttentionCategory !== null;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const workspaceColor = resolveWorkspaceColor(color)?.value;

  useEffect(() => {
    if (editing) {
      setEditValue(name);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [editing, name]);

  // Only a *change* of the signal opens the editor. Depending on the raw value
  // would re-open rename every time the parent hands down a fresh onRename
  // closure, which it does on nearly every sidebar render.
  const lastRenameSignal = useRef(renameSignal);
  useEffect(() => {
    if (renameSignal === lastRenameSignal.current) return;
    lastRenameSignal.current = renameSignal;
    if (onRename) setEditing(true);
  }, [renameSignal, onRename]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name && onRename) {
      onRename(trimmed);
    }
    setEditing(false);
  }, [editValue, name, onRename]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRename) setEditing(true);
  }, [onRename]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setEditing(false);
  }, [commitRename]);

  return (
    <div
      onClick={onClick}
      onDoubleClick={handleDoubleClick}
      className={`tab-workspace-item${uiVariant === "cmux" ? " cmux-workspace-item" : ""}`}
      data-active-workspace={active ? "true" : undefined}
      data-workspace-color={workspaceColor ?? undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "9px 10px 9px 12px",
        cursor: "pointer",
        // Two independent signals share this row, so they use disjoint
        // channels: the far-left 3px bar is the workspace group color, while
        // "active" stays the selected surface + inset ring + bold label. A
        // colored row keeps both by mixing the group tint *over* whichever
        // surface the active state already chose.
        background: workspaceRowBackground(
          workspaceColor,
          active,
          active ? "var(--cmux-selected)" : "transparent",
        ),
        color: active ? "var(--cmux-text)" : "var(--cmux-text-secondary)",
        fontSize: "13px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        userSelect: "none",
        borderRadius: uiVariant === "cmux" ? "0 6px 6px 0" : "0 6px 6px 0",
        borderLeft: workspaceColor
          ? `3px solid ${workspaceColor}`
          : active ? "3px solid var(--cmux-accent)" : "3px solid transparent",
        boxShadow: active ? "inset 0 0 0 1px color-mix(in srgb, var(--cmux-text) 10%, transparent)" : "none",
        margin: "0 8px 0 0",
        marginTop: "2px",
      } as React.CSSProperties & Record<string, string | number>}
    >
      {showPet && petAtlasUrl && <PetSprite atlasUrl={petAtlasUrl} state={petState} height={40} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, overflow: "hidden", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {notificationCount ? (
            <span key={`waiting-${notificationCount}`} className="cmux-badge-pop" title="Waiting for approval" style={{
              background: "var(--status-waiting)",
              color: "var(--cmux-on-waiting)",
              fontSize: "10px",
              fontWeight: "bold",
              borderRadius: "50%",
              width: "14px",
              height: "14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0
            }}>
              {notificationCount}
            </span>
          ) : workDoneCount ? (
            <span key={`done-${workDoneCount}`} className="cmux-badge-pop" title="Work done" style={{
              background: "var(--status-done)",
              color: "var(--cmux-on-done)",
              fontSize: "10px",
              fontWeight: "bold",
              borderRadius: "50%",
              width: "14px",
              height: "14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0
            }}>
              {workDoneCount}
            </span>
          ) : null}
          {editing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "var(--cmux-selected)",
                border: "1px solid var(--cmux-accent, #007aff)",
                borderRadius: 4,
                color: "inherit",
                fontSize: "inherit",
                fontWeight: 600,
                fontFamily: "inherit",
                padding: "1px 4px",
                outline: "none",
                width: "100%",
                minWidth: 0,
              }}
            />
          ) : (
            <span
              title={name}
              style={{
                flex: 1,
                minWidth: 0,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                lineHeight: 1.25,
              }}
            >
              {name}
            </span>
          )}
          <span className="cmux-pill" style={{
            flexShrink: 0,
            background: active ? "color-mix(in srgb, var(--cmux-text) 16%, transparent)" : "color-mix(in srgb, var(--cmux-text) 9%, transparent)",
            color: active ? "var(--cmux-text)" : "var(--cmux-text-tertiary)"
          }}>
            {paneCount} {paneCount === 1 ? "pane" : "panes"}
          </span>
        </div>
        {(hasAgents || hasAgentKinds || hasUnseenAttention) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {hasUnseenAttention && unseenAttentionCategory && (
              <UnseenAttentionRing count={unseenAttentionCount} category={unseenAttentionCategory} />
            )}
            {statusCounts && statusCounts.working > 0 && <StatusPip count={statusCounts.working} color="var(--status-working)" pulse />}
            {statusCounts && statusCounts.waiting > 0 && <StatusPip count={statusCounts.waiting} color="var(--status-waiting)" />}
            {hasAgentKinds && (
              <span
                className="workspace-agent-kind-dots"
                role="img"
                aria-label={`Agents: ${agentKinds.map((kind) => AGENT_KIND_ACCESSIBLE_LABELS[kind]).join(", ")}`}
              >
                {agentKinds.map((kind) => (
                  <span
                    key={kind}
                    className="workspace-agent-kind-dot"
                    aria-hidden="true"
                    style={{ "--agent-kind-color": KIND_COLORS[kind].fg } as AgentKindStyle}
                  />
                ))}
              </span>
            )}
          </div>
        )}
        {lastLogLine && (
          <span style={{
            fontSize: "12px",
            color: active ? "var(--cmux-text)" : "var(--cmux-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: 1.2
          }}>
            {lastLogLine}
          </span>
        )}
        <span style={{
          fontSize: "11px",
          color: "var(--cmux-text-tertiary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: 1.2
        }}>
          {cwd ? cwd.replace(/^\/home\/[^\/]+/, '~') : 'Starting session...'}
          {gitBranch ? ` —  ${gitBranch}` : ''}
        </span>
      </div>

      {onMenu && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onMenu(rect.left, rect.bottom + 4);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{
            background: "none",
            border: "none",
            color: "var(--cmux-text-tertiary)",
            cursor: "pointer",
            fontSize: "12px",
            padding: "2px 4px",
            lineHeight: 1,
            flexShrink: 0,
            opacity: 0,
          }}
          title="ワークスペースのメニュー"
          aria-haspopup="menu"
          className="tab-close-btn"
        >
          ⋮
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          background: "none",
          border: "none",
          color: "var(--cmux-text-tertiary)",
          cursor: "pointer",
          fontSize: "12px",
          padding: "2px 4px",
          lineHeight: 1,
          flexShrink: 0,
          opacity: 0,
        }}
        title="Close workspace"
        className="tab-close-btn"
      >
        ×
      </button>
    </div>
  );
});
