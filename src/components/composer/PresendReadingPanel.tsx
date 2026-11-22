import type { PresendReading } from "../../lib/presendReading";

interface Props {
  reading: PresendReading | null;
  pending: boolean;
  tabEnabled: boolean;
  onToggle: () => void;
  onAppend: (kind: "assumption" | "missing", value: string) => void;
}
const TITLE = "\u88dc\u52a9 AI \u306e\u8aad\u307f (\u9001\u4fe1\u5148\u306e AI \u306e\u8003\u3048\u3067\u306f\u3042\u308a\u307e\u305b\u3093)";
const NONE = "\u306a\u3057";

export function PresendReadingPanel({ reading, pending, tabEnabled, onToggle, onAppend }: Props) {
  const row = (key: "reading" | "assumption" | "missing", label: string) => {
    const value = reading?.[key] ?? "";
    const className = `cmux-presend-row${value === NONE ? " is-none" : ""}`;
    const content = <><span className="cmux-presend-label">{label}</span><span className="cmux-presend-value" title={value}>{value}</span></>;
    return key === "reading" ? <div className={className}>{content}</div> : (
      <button type="button" className={className} disabled={!value || value === NONE}
        onMouseDown={event => event.preventDefault()} onClick={() => onAppend(key, value)}>{content}</button>
    );
  };
  return (
    <div className="cmux-presend-frame" aria-label={TITLE}>
      <div className="cmux-presend-header">
        <span className="cmux-presend-title" title={TITLE}>{TITLE}</span>
        <span className="cmux-presend-pending" role="status" aria-label={pending ? "\u8aad\u307f\u53d6\u308a\u4e2d" : undefined}>{pending ? "\u2026" : ""}</span>
        <button type="button" className="cmux-presend-toggle" aria-pressed={tabEnabled}
          onMouseDown={event => event.preventDefault()} onClick={onToggle}>
          {tabEnabled ? "\u3053\u306e\u30bf\u30d6\u3067\u5207\u308b" : "\u3053\u306e\u30bf\u30d6\u3067\u4f7f\u3046"}
        </button>
      </div>
      {row("reading", "\u8aad\u307f")}
      {row("assumption", "\u4eee\u5b9a")}
      {row("missing", "\u4e0d\u8db3")}
    </div>
  );
}
