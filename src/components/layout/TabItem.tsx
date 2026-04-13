import { memo, useState, useRef, useCallback, useEffect } from "react";

interface StatusCounts {
  working: number;
  waiting: number;
  done: number;
}

interface TabItemProps {
  uiVariant?: "default" | "cmux";
  index: number;
  name: string;
  color?: string;
  paneCount: number;
  cwd?: string;
  gitBranch?: string;
  notificationCount?: number;
  workDoneCount?: number;
  lastLogLine?: string;
  statusCounts?: StatusCounts;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename?: (newName: string) => void;
}

function StatusPip({ count, color, pulse }: { count: number; color: string; pulse?: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: pulse ? `0 0 4px ${color}` : "none",
        animation: pulse ? "agentPulse 1.2s ease-in-out infinite" : "none",
      }} />
      {count > 1 && (
        <span style={{ fontSize: 10, color, fontWeight: 600, lineHeight: 1 }}>{count}</span>
      )}
    </span>
  );
}

export default memo(function TabItem({ uiVariant = "default", index, name, color, paneCount, cwd, gitBranch, notificationCount, workDoneCount, lastLogLine, statusCounts, active, onClick, onClose, onRename }: TabItemProps) {
  const hasAgents = statusCounts && (statusCounts.working + statusCounts.waiting + statusCounts.done) > 0;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setEditValue(name);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [editing, name]);

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
      className={uiVariant === "cmux" ? "cmux-workspace-item" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        cursor: "pointer",
        background: active ? "rgba(255,255,255,0.06)" : "transparent",
        color: active
          ? (uiVariant === "cmux" ? "#f3f3f3" : "#ffffff")
          : "var(--cmux-text-secondary)",
        fontSize: "13px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        userSelect: "none",
        transition: "background 0.1s, color 0.1s, border-color 0.1s",
        borderRadius: uiVariant === "cmux" ? "0 8px 8px 0" : "0 6px 6px 0",
        borderLeft: active
          ? `3px solid ${color || "var(--cmux-accent)"}`
          : "3px solid transparent",
        margin: "0 8px 0 0",
        marginTop: "4px"
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)";
          e.currentTarget.style.color = "var(--cmux-text)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--cmux-text-secondary)";
        }
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, overflow: "hidden", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {index < 9 && (
            <span style={{
              fontSize: 10,
              fontWeight: 500,
              color: active ? "rgba(255,255,255,0.45)" : "var(--cmux-text-tertiary)",
              fontFamily: "monospace",
              flexShrink: 0,
              minWidth: 12,
              textAlign: "center",
              lineHeight: 1,
            }}>
              {index + 1}
            </span>
          )}
          {color && (
            <div style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color,
              flexShrink: 0,
              opacity: active ? 1 : 0.7,
            }} />
          )}
          {notificationCount ? (
            <span title="Waiting for approval" style={{
              background: "#ff3b30",
              color: "white",
              fontSize: "9px",
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
            <span title="Work done" style={{
              background: "#30d158",
              color: "white",
              fontSize: "9px",
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
                background: "rgba(255,255,255,0.1)",
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
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight: active ? 600 : 500,
              }}
            >
              {name}
            </span>
          )}
          {paneCount > 1 && (
            <span className="cmux-pill" style={{
              flexShrink: 0,
              background: active ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)",
              color: active ? "#ffffff" : "var(--cmux-text-secondary)"
            }}>
              {paneCount}
            </span>
          )}
        </div>
        {hasAgents && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 1 }}>
            {statusCounts!.working > 0 && <StatusPip count={statusCounts!.working} color="var(--status-working)" pulse />}
            {statusCounts!.waiting > 0 && <StatusPip count={statusCounts!.waiting} color="var(--status-waiting)" />}
            {statusCounts!.done > 0    && <StatusPip count={statusCounts!.done}    color="var(--status-done)" />}
          </div>
        )}
        {lastLogLine && (
          <span style={{
            fontSize: "12px",
            color: active ? "rgba(255,255,255,0.85)" : "var(--cmux-text-secondary)",
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
          color: active ? "rgba(255,255,255,0.6)" : "var(--cmux-text-tertiary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: 1.2
        }}>
          {cwd ? cwd.replace(/^\/home\/[^\/]+/, '~') : 'Starting session...'}
          {gitBranch ? ` —  ${gitBranch}` : ''}
        </span>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{
          background: "none",
          border: "none",
          color: active ? "rgba(255,255,255,0.6)" : "var(--cmux-text-tertiary)",
          cursor: "pointer",
          fontSize: "12px",
          padding: "2px 4px",
          lineHeight: 1,
          flexShrink: 0,
          opacity: 0,
          transition: "opacity 0.1s, color 0.1s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = active ? "#ffffff" : "var(--cmux-text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = active ? "rgba(255,255,255,0.6)" : "var(--cmux-text-tertiary)";
        }}
        title="Close workspace"
        className="tab-close-btn"
      >
        ×
      </button>
    </div>
  );
});
