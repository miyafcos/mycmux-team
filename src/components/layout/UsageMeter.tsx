import { useEffect, useRef, useState } from "react";
import { useUsageStore, type UsageSummary, type WindowStat } from "../../stores/usageStore";
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

  if (mode === "hidden") {
    return null;
  }

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
      title={lastError ?? "Usage"}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: 24,
        padding: "0 5px",
        color: "var(--cmux-text-tertiary)",
        fontSize: 11,
        letterSpacing: 0,
        whiteSpace: "nowrap",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {summary ? (
        mode === "compact" ? (
          <CompactMeter summary={summary} />
        ) : (
          <FullMeter summary={summary} />
        )
      ) : (
        <span style={{ color: "var(--cmux-text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
          CC -- CX --
        </span>
      )}

      {lastError && (
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

      {isOpen && summary && <UsagePopover summary={summary} lastError={lastError} />}
    </div>
  );
}

function FullMeter({ summary }: { summary: UsageSummary }) {
  return (
    <>
      <span style={groupStyle}>
        <span>CC</span>
        <MiniStat label="5h" stat={summary.claude_5h} />
        <MiniStat label="7d" stat={summary.claude_7d} />
      </span>
      <span style={groupStyle}>
        <span>CX</span>
        <MiniStat label="5h" stat={summary.codex_5h} />
        <MiniStat label="7d" stat={summary.codex_7d} />
      </span>
    </>
  );
}

function CompactMeter({ summary }: { summary: UsageSummary }) {
  return (
    <>
      <span style={compactGroupStyle}>
        CC {formatPct(summary.claude_5h.pct)}/{formatPct(summary.claude_7d.pct)}
      </span>
      <span style={compactGroupStyle}>
        CX {formatPct(summary.codex_5h.pct)}/{formatPct(summary.codex_7d.pct)}
      </span>
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
    text: "var(--cmux-text-tertiary)",
    pulse: false,
  };
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
  color: "var(--cmux-text-tertiary)",
  fontVariantNumeric: "tabular-nums",
} as const;
