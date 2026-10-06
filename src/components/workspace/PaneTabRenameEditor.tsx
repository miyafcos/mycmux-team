import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { clampMenuPosition } from "../../lib/menuPosition";

/** Independent of tab selection, restore, chip density and scroll clipping. */
export function PaneTabRenameEditor({ label, value, anchor, onChange, onSave, onCancel }: {
  label: string;
  value: string;
  anchor?: DOMRect;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const width = Math.min(300, Math.max(160, window.innerWidth - 16));
  const position = clampMenuPosition(anchor?.left ?? 16, anchor?.bottom ?? 16, width, 90);
  return createPortal(
    <div className="pane-tabbar" role="dialog" aria-label={"\u30da\u30a4\u30f3\u306e\u540d\u524d\u3092\u5909\u66f4"}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onCancel(); }
      }}
      style={{ position: "fixed", zIndex: 200, top: position.top, left: position.left, width,
        display: "block", height: "auto", minHeight: 0, margin: 0, flex: "initial", overflow: "visible",
        boxSizing: "border-box", padding: 10, borderRadius: 6, background: "var(--cmux-popover)",
        color: "var(--cmux-text)", border: "1px solid var(--cmux-border)", boxShadow: "0 4px 16px #0004" }}>
      <label style={{ display: "block", fontSize: 12, marginBottom: 6 }}>
        {label}
        <input ref={input} data-pane-tab-rename-input aria-label={"\u30da\u30a4\u30f3\u540d"} value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") { event.preventDefault(); onSave(); }
            if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          }}
          style={{ display: "block", width: "100%", boxSizing: "border-box", padding: "4px 6px", marginTop: 4,
            fontSize: 13, color: "var(--cmux-text)", background: "var(--cmux-selected)",
            border: "1px solid var(--cmux-accent)", borderRadius: 4, userSelect: "text" }} />
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button className="pane-action-btn" type="button" onClick={onCancel}>{"\u3084\u3081\u308b"}</button>
        <button className="pane-action-btn" type="button" onClick={onSave}>{"\u4fdd\u5b58"}</button>
      </div>
    </div>, document.body,
  );
}
