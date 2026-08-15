/**
 * Small shared pieces for the AI log dashboard: section frames, tables, chips
 * and the three empty states.
 *
 * Every control here is a plain left-click button. The dashboard deliberately
 * has no context menu — right click is not a supported input in this app.
 */

import { useState, type CSSProperties, type ReactNode } from "react";

export const cardStyle: CSSProperties = {
  background: "var(--cmux-surface)",
  border: "1px solid var(--cmux-border)",
  borderRadius: "var(--cmux-radius-lg)",
  padding: "14px 16px 16px",
};

export const noteStyle: CSSProperties = {
  fontSize: "var(--cmux-font-size-xs)",
  lineHeight: 1.5,
  color: "var(--cmux-text-tertiary)",
};

export const subtleButtonStyle: CSSProperties = {
  border: "1px solid var(--cmux-border)",
  borderRadius: 5,
  background: "var(--cmux-hover)",
  color: "var(--cmux-text)",
  padding: "4px 9px",
  fontSize: "var(--cmux-font-size-xs)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function Section({
  title,
  subtitle,
  actions,
  children,
  id,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} style={{ ...cardStyle, minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: "var(--cmux-font-size-md)", fontWeight: 700, color: "var(--cmux-text)" }}>{title}</h2>
          {subtitle ? <div style={{ ...noteStyle, marginTop: 3 }}>{subtitle}</div> : null}
        </div>
        {actions ? <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "warn";
  title?: string;
}) {
  const color =
    tone === "accent"
      ? "var(--cmux-accent)"
      : tone === "warn"
        ? "var(--cmux-usage-warn)"
        : "var(--cmux-text-secondary)";
  return (
    <span
      title={title}
      style={{
        padding: "2px 7px",
        borderRadius: 999,
        background: "var(--cmux-hover)",
        border: "1px solid var(--cmux-border-hairline)",
        color,
        fontSize: "var(--cmux-font-size-xs)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Toggle rendered as a row of buttons (no select element, no context menu). */
export function ButtonGroup<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  roleLabel = ariaLabel,
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Visible counterpart to the group name; ariaLabel alone is not enough context. */
  roleLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
      <span style={{ alignSelf: "center", color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)", whiteSpace: "nowrap" }}>{roleLabel}:</span>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            style={{
              ...subtleButtonStyle,
              padding: "3px 8px",
              fontSize: "var(--cmux-font-size-xs)",
              background: active ? "var(--cmux-accent)" : "var(--cmux-hover)",
              color: active ? "var(--cmux-on-accent)" : "var(--cmux-text-secondary)",
              borderColor: active ? "var(--cmux-accent)" : "var(--cmux-border)",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Wide content scrolls inside its own box; the page body never scrolls sideways. */
export function ScrollBox({ children, maxHeight }: { children: ReactNode; maxHeight?: number }) {
  return (
    <div style={{ overflowX: "auto", overflowY: maxHeight ? "auto" : undefined, maxHeight, minWidth: 0 }}>
      {children}
    </div>
  );
}

export const tableStyle: CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: "var(--cmux-font-size-xs)",
  fontVariantNumeric: "tabular-nums",
};

export const thStyle: CSSProperties = {
  textAlign: "right",
  padding: "5px 8px",
  color: "var(--cmux-text-tertiary)",
  fontWeight: 600,
  fontSize: "var(--cmux-font-size-xs)",
  borderBottom: "1px solid var(--cmux-border)",
  whiteSpace: "nowrap",
};

export const thLeftStyle: CSSProperties = { ...thStyle, textAlign: "left" };

export const tdStyle: CSSProperties = {
  textAlign: "right",
  padding: "5px 8px",
  color: "var(--cmux-text)",
  borderBottom: "1px solid var(--cmux-border-hairline)",
  whiteSpace: "nowrap",
};

export const tdLeftStyle: CSSProperties = {
  ...tdStyle,
  textAlign: "left",
  maxWidth: 280,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export function ShareBar({ pct, title }: { pct: number; title?: string }) {
  const width = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <span
      title={title}
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 46,
        height: 5,
        borderRadius: 3,
        background: "var(--cmux-hover)",
        overflow: "hidden",
        verticalAlign: "middle",
      }}
    >
      <span style={{ display: "block", width: `${width}%`, height: "100%", background: "var(--cmux-accent)" }} />
    </span>
  );
}

export type EmptyStateKind = "not-indexed" | "no-data" | "error";

/**
 * The three states the dashboard must be able to show without pretending to
 * have data: never indexed, indexed but nothing in this range, and a failed
 * call. An error is never rendered as an empty table.
 */
export function EmptyState({
  kind,
  message,
  onPrimary,
  primaryLabel,
  busy = false,
}: {
  kind: EmptyStateKind;
  message?: string | null;
  onPrimary?: () => void;
  primaryLabel?: string;
  busy?: boolean;
}) {
  const copy: Record<EmptyStateKind, { title: string; body: string; action: string }> = {
    "not-indexed": {
      title: "まだインデックスを作っていません",
      body: "Claude と Codex の記録を読み込むと、ここに集計が出ます。初回は数十秒かかります。",
      action: "インデックスを作成",
    },
    "no-data": {
      title: "この期間に記録がありません",
      body: "期間を広げるか、再インデックスで最新の記録を取り込んでください。",
      action: "再インデックス",
    },
    error: {
      title: "読み込みに失敗しました",
      body: "取得できた範囲でも表を作らず、原因をそのまま出しています。",
      action: "再試行",
    },
  };
  const entry = copy[kind];
  return (
    <div
      role="status"
      style={{
        ...cardStyle,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 8,
        borderStyle: kind === "error" ? "solid" : "dashed",
        borderColor: kind === "error" ? "var(--cmux-red)" : "var(--cmux-border)",
      }}
    >
      <div style={{ fontSize: "var(--cmux-font-size-sm)", fontWeight: 700, color: kind === "error" ? "var(--cmux-red)" : "var(--cmux-text)" }}>
        {entry.title}
      </div>
      <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)", lineHeight: 1.6 }}>{entry.body}</div>
      {message ? (
        <pre
          style={{
            margin: 0,
            maxWidth: "100%",
            maxHeight: 140,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontSize: "var(--cmux-font-size-xs)",
            color: "var(--cmux-text-secondary)",
            background: "var(--cmux-hover)",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          {message}
        </pre>
      ) : null}
      {onPrimary ? (
        <button type="button" disabled={busy} onClick={onPrimary} style={{ ...subtleButtonStyle, opacity: busy ? 0.5 : 1 }}>
          {busy ? "実行中…" : (primaryLabel ?? entry.action)}
        </button>
      ) : null}
    </div>
  );
}

export function SkeletonBlock({ height = 90, label }: { height?: number; label: string }) {
  return (
    <div
      aria-label={label}
      role="status"
      style={{
        height,
        borderRadius: 8,
        background: "var(--cmux-hover)",
        opacity: 0.6,
      }}
    />
  );
}

/** Keeps previous data visible while its replacement is loading. */
export function RefreshingBlock({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <div aria-busy={busy} data-ailog-refreshing={busy ? "true" : "false"} style={{ minWidth: 0 }}>
      {busy ? (
        <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, color: "var(--cmux-text-tertiary)", fontSize: "var(--cmux-font-size-xs)" }}>
          <span>更新中…</span>
          <span aria-hidden="true" style={{ display: "block", flex: 1, maxWidth: 72, height: 3, borderRadius: 999, background: "var(--cmux-accent)", opacity: 0.8 }} />
        </div>
      ) : null}
      <div style={{ opacity: busy ? 0.55 : 1, transition: "opacity var(--cmux-motion-fast) var(--cmux-ease)" }}>{children}</div>
    </div>
  );
}

/** A closed details block that does not mount its contents until opened. */
export function DeferredDetails({ summary, subtitle, children }: { summary: string; subtitle?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} style={{ ...cardStyle, padding: 0 }}>
      <summary style={{ cursor: "pointer", padding: "14px 16px", color: "var(--cmux-text)", fontSize: "var(--cmux-font-size-md)", fontWeight: 700 }}>{summary}</summary>
      {open ? <div style={{ padding: "0 16px 16px" }}>{subtitle ? <div style={{ ...noteStyle, marginBottom: 10 }}>{subtitle}</div> : null}{children}</div> : null}
    </details>
  );
}
