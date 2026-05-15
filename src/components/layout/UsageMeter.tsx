import { useEffect, useRef, useState } from "react";
import { useUsageStore, type WindowStat } from "../../stores/usageStore";
import { UsagePopover } from "./UsagePopover";

type MeterMode = "full" | "compact" | "hidden";

export function UsageMeter() {
  const summary = useUsageStore((state) => state.summary);
  const lastError = useUsageStore((state) => state.lastError);
  const fetchUsage = useUsageStore((state) => state.fetch);
  const [mode, setMode] = useState<MeterMode>(getMeterMode);
  const [isOpen, setIsOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void fetchUsage();
    const interval = window.setInterval(() => {
      void fetchUsage();
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [fetchUsage]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const compactQuery = window.matchMedia("(max-width: 900px)");
    const hiddenQuery = window.matchMedia("(max-width: 700px)");
    const update = () => setMode(getMeterMode());
    update();
    compactQuery.addEventListener("change", update);
    hiddenQuery.addEventListener("change", update);

    return () => {
      compactQuery.removeEventListener("change", update);
      hiddenQuery.removeEventListener("change", update);
    };
  }, []);

  if (mode === "hidden" || !summary) {
    return null;
  }

  const showClaude = summary.claude_available && summary.claude_5h;
  const showCodex = summary.codex_available && summary.codex_5h;

  if (!showClaude && !showCodex) {
    return null;
  }

  const title = [summary.claude_error, summary.codex_error, lastError].filter(Boolean).join("\n") || "Usage";

  const open = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  };

  const close = () => {
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
      closeTimerRef.current = null;
    }, 200);
  };

  return (
    <div
      onMouseEnter={open}
      onMouseLeave={close}
      title={title}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: 24,
        padding: "0 5px",
        color: "var(--cmux-text-secondary)",
        fontSize: 11,
        letterSpacing: 0,
        whiteSpace: "nowrap",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {mode === "compact" ? (
        <CompactMeter
          claude5h={summary.claude_5h}
          claude7d={summary.claude_7d}
          codex5h={summary.codex_5h}
          codex7d={summary.codex_7d}
          showClaude={Boolean(showClaude)}
          showCodex={Boolean(showCodex)}
        />
      ) : (
        <FullMeter
          claude5h={summary.claude_5h}
          claude7d={summary.claude_7d}
          codex5h={summary.codex_5h}
          codex7d={summary.codex_7d}
          showClaude={Boolean(showClaude)}
          showCodex={Boolean(showCodex)}
        />
      )}

      {(lastError || summary.claude_error || summary.codex_error) && (
        <span
          style={{
            position: "absolute",
            top: 2,
            right: 1,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--cmux-usage-danger)",
          }}
        />
      )}

      {isOpen && <UsagePopover summary={summary} lastError={lastError} />}
    </div>
  );
}

type MeterStatsProps = {
  claude5h: WindowStat | null;
  claude7d: WindowStat | null;
  codex5h: WindowStat | null;
  codex7d: WindowStat | null;
  showClaude: boolean;
  showCodex: boolean;
};

function FullMeter({ claude5h, claude7d, codex5h, codex7d, showClaude, showCodex }: MeterStatsProps) {
  return (
    <>
      {showClaude && claude5h && (
        <span style={groupStyle}>
        <span>CC</span>
          <MiniStat label="5h" stat={claude5h} />
          {claude7d && <MiniStat label="7d" stat={claude7d} />}
        </span>
      )}
      {showCodex && codex5h && (
        <span style={groupStyle}>
        <span>CX</span>
          <MiniStat label="5h" stat={codex5h} />
          {codex7d && <MiniStat label="7d" stat={codex7d} />}
        </span>
      )}
    </>
  );
}

function CompactMeter({ claude5h, claude7d, codex5h, codex7d, showClaude, showCodex }: MeterStatsProps) {
  return (
    <>
      {showClaude && claude5h && (
        <span style={{ ...compactGroupStyle, color: compactColor(claude5h, claude7d) }}>
          CC {formatPct(claude5h.pct)}
          {claude7d ? `/${formatPct(claude7d.pct)}` : ""}
        </span>
      )}
      {showCodex && codex5h && (
        <span style={{ ...compactGroupStyle, color: compactColor(codex5h, codex7d) }}>
          CX {formatPct(codex5h.pct)}
          {codex7d ? `/${formatPct(codex7d.pct)}` : ""}
        </span>
      )}
    </>
  );
}

function MiniStat({ label, stat }: { label: string; stat: WindowStat }) {
  const severity = getSeverity(stat.pct);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        color: severity.text,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span>{label}</span>
      <FiveCellBar stat={stat} color={severity.bar} pulse={severity.pulse} />
      <span>{formatPct(stat.pct)}</span>
    </span>
  );
}

function FiveCellBar({ stat, color, pulse }: { stat: WindowStat; color: string; pulse: boolean }) {
  const filled = Math.ceil(Math.min(Math.max(stat.pct, 0), 100) / 20);

  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          style={{
            width: 6,
            height: 6,
            marginRight: index === 4 ? 0 : 1,
            borderRadius: 1,
            background: index < filled ? color : "rgba(255,255,255,0.12)",
            animation: index < filled && pulse ? "cmux-usage-pulse 1s infinite" : undefined,
          }}
        />
      ))}
    </span>
  );
}

function getSeverity(pct: number): { bar: string; text: string; pulse: boolean } {
  if (pct >= 95) {
    return {
      bar: "var(--cmux-usage-danger)",
      text: "var(--cmux-usage-danger)",
      pulse: true,
    };
  }
  if (pct >= 80) {
    return {
      bar: "var(--cmux-usage-warn)",
      text: "var(--cmux-usage-warn)",
      pulse: false,
    };
  }
  return {
    bar: "var(--cmux-usage-ok)",
    text: "var(--cmux-text-secondary)",
    pulse: false,
  };
}

function compactColor(...stats: Array<WindowStat | null>): string {
  const pct = Math.max(...stats.map((stat) => stat?.pct ?? 0));
  if (pct >= 95) {
    return "var(--cmux-usage-danger)";
  }
  if (pct >= 80) {
    return "var(--cmux-usage-warn)";
  }
  return "var(--cmux-text-secondary)";
}

function getMeterMode(): MeterMode {
  if (typeof window === "undefined") {
    return "full";
  }
  if (window.matchMedia("(max-width: 700px)").matches) {
    return "hidden";
  }
  if (window.matchMedia("(max-width: 900px)").matches) {
    return "compact";
  }
  return "full";
}

function formatPct(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  return `${Math.round(clamped)}%`;
}

const groupStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
} as const;

const compactGroupStyle = {
  display: "inline-flex",
  alignItems: "center",
  color: "var(--cmux-text-secondary)",
  fontVariantNumeric: "tabular-nums",
} as const;
