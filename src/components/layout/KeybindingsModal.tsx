import { useMemo, useState, useEffect } from "react";
import type { JSX } from "react";
import { OverlayShell } from "../common/OverlayShell";
import {
  KEYBINDING_DEFINITIONS,
  formatShortcutLabel,
  getActionDefinition,
  shortcutFromKeyboardEvent,
  type KeybindingActionId,
} from "../../lib/keybindings";
import { useKeybindingStore } from "../../stores/keybindingStore";

interface KeybindingsModalProps {
  closing?: boolean;
  onClose: () => void;
}

interface KeybindingsPanelProps {
  embedded?: boolean;
  hosted?: boolean;
  closing?: boolean;
  onClose?: () => void;
}

// Content-only panel: shared by the standalone modal below and by the host
// SettingsDialog, which embeds this without a backdrop/Escape-close of its
// own. Rebind capture (and its capture-phase Escape cancel) always lives
// here regardless of embedding, since that capture-phase stopPropagation is
// what keeps a host's own Escape-close from firing mid-capture.
export function KeybindingsPanel({ embedded = false, hosted = false, closing = false, onClose }: KeybindingsPanelProps): JSX.Element {
  const keybindings = useKeybindingStore((s) => s.keybindings);
  const overrides = useKeybindingStore((s) => s.overrides);
  const setOverride = useKeybindingStore((s) => s.setOverride);
  const clearOverride = useKeybindingStore((s) => s.clearOverride);
  const resetAll = useKeybindingStore((s) => s.resetAll);
  const getConflicts = useKeybindingStore((s) => s.getConflicts);

  const [capturing, setCapturing] = useState<KeybindingActionId | null>(null);

  const conflictGroups = useMemo(() => getConflicts(), [keybindings, getConflicts]);
  const conflictActions = useMemo(
    () => new Set(conflictGroups.flatMap((group) => group.actions)),
    [conflictGroups],
  );

  useEffect(() => {
    if (closing) {
      setCapturing(null);
      return;
    }
    if (!capturing) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        clearOverride(capturing);
        setCapturing(null);
        return;
      }

      const shortcut = shortcutFromKeyboardEvent(e);
      if (!shortcut) return;
      setOverride(capturing, shortcut);
      setCapturing(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, clearOverride, closing, setOverride]);

  const contentOnly = embedded || hosted;

  return (
    <div
      className={contentOnly ? undefined : `cmux-overlay-panel${closing ? " is-closing" : ""}`}
      onClick={(e) => e.stopPropagation()}
      style={{
        // Embedded (settings tab): fill the host's content column and let the
        // host own chrome + scrolling. Standalone: the original modal panel.
        width: contentOnly ? "100%" : "min(920px, 94vw)",
        maxHeight: contentOnly ? undefined : "88vh",
        flex: hosted ? 1 : undefined,
        minHeight: hosted ? 0 : undefined,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: contentOnly ? "transparent" : "var(--cmux-surface)",
        border: contentOnly ? "none" : "1px solid var(--cmux-border)",
        borderRadius: contentOnly ? 0 : 8,
      }}
    >
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--cmux-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: "var(--cmux-text)", fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700 }}>
          Keyboard Shortcuts
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={resetAll}
            style={{
              background: "transparent",
              border: "1px solid var(--cmux-border)",
              color: "var(--cmux-text-secondary)",
              borderRadius: 4,
              padding: "6px 10px",
              fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace",
              cursor: "pointer",
            }}
          >
            Restore defaults
          </button>
          {!embedded && (
            <button
              onClick={onClose}
              style={{
                background: "var(--cmux-accent)",
                border: "1px solid var(--cmux-accent)",
                color: "var(--cmux-on-accent)",
                borderRadius: 4,
                padding: "6px 10px",
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
                cursor: "pointer",
              }}
            >
              Done
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: "10px 16px", color: "var(--cmux-text-tertiary)", fontSize: 11, fontFamily: "'JetBrains Mono', monospace", borderBottom: "1px solid var(--cmux-border)" }}>
        Click Rebind, then press a shortcut. Press Backspace/Delete to clear.
      </div>

      {conflictGroups.length > 0 && (
        <div
          aria-live="polite"
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--cmux-border)",
            background: "color-mix(in srgb, var(--cmux-red) 10%, transparent)",
            color: "var(--cmux-red)",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            lineHeight: 1.5,
          }}
        >
          Duplicate shortcut warning:{" "}
          {conflictGroups.map((group) => (
            `${formatShortcutLabel(group.shortcut)} (${group.actions.map((action) => getActionDefinition(action).title).join(", ")})`
          )).join("; ")}
        </div>
      )}

      <div style={{ overflow: "auto", padding: "4px 0" }}>
        {KEYBINDING_DEFINITIONS.map((def) => {
          const current = keybindings[def.action];
          const overridden = overrides[def.action] !== undefined;
          const hasConflict = conflictActions.has(def.action);
          const isCapturing = capturing === def.action;

          return (
            <div
              key={def.action}
              style={{
                display: "grid",
                gridTemplateColumns: "160px 1fr 190px 170px",
                gap: 10,
                alignItems: "center",
                padding: "8px 16px",
                borderBottom: "1px solid color-mix(in srgb, var(--cmux-border) 45%, transparent)",
              }}
            >
              <div style={{ fontSize: 11, color: "var(--cmux-text-tertiary)", fontFamily: "'JetBrains Mono', monospace" }}>
                {def.category}
              </div>
              <div style={{ fontSize: 12, color: "var(--cmux-text)", fontFamily: "'JetBrains Mono', monospace" }}>
                {def.title}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: hasConflict ? "var(--cmux-red)" : "var(--cmux-text-secondary)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {isCapturing ? "Press keys..." : formatShortcutLabel(current)}
                {overridden ? " *" : ""}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                <button
                  onClick={() => setCapturing(def.action)}
                  style={{
                    background: "transparent",
                    border: "1px solid var(--cmux-border)",
                    color: "var(--cmux-text-secondary)",
                    borderRadius: 4,
                    padding: "4px 8px",
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono', monospace",
                    cursor: "pointer",
                  }}
                >
                  Rebind
                </button>
                <button
                  onClick={() => clearOverride(def.action)}
                  disabled={!overridden}
                  style={{
                    background: "transparent",
                    border: "1px solid var(--cmux-border)",
                    color: overridden ? "var(--cmux-text-secondary)" : "var(--cmux-text-tertiary)",
                    borderRadius: 4,
                    padding: "4px 8px",
                    fontSize: 11,
                    fontFamily: "'JetBrains Mono', monospace",
                    cursor: overridden ? "pointer" : "not-allowed",
                  }}
                >
                  Reset
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function KeybindingsModal({ closing = false, onClose }: KeybindingsModalProps) {
  return (
    <OverlayShell
      open={!closing}
      closing={closing}
      onClose={onClose}
      size="full"
      layer="top"
      ariaLabel="キーボードショートカット"
    >
      <KeybindingsPanel hosted closing={closing} onClose={onClose} />
    </OverlayShell>
  );
}
