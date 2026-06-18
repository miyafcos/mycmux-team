import { useEffect, useRef, useState } from "react";
import { UsagePopover } from "./UsagePopover";
import { useUsageStore, type WindowStat } from "../../stores/usageStore";

type MeterMode = "full" | "compact" | "hidden";

export function UsageMeter() {
  const summary = useUsageStore((state) => state.summary);
  const lastError = useUsageStore((state) => state.lastError);
  const fetchUsage = useUsageStore((state) => state.fetch);
  const mode = useMeterMode();
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
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
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

  const handleOpen = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  };

  const handleClose = () => {
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
      closeTimerRef.current = null;
    }, 200);
  };

  return (
    <div
      onMouseEnter={handleOpen}
      onMouseLeave={handleClose}
      style={{
        position: "relative",
        height: 24,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 5px",
        color: "var(--cmux-text-secondary)",
        fontSize: 11,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        whiteSpace: "nowrap",
      }}
      title={title}
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
            right: 0,
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
      {showClaude && claude5h && <Metric label="CC 5h" stat={claude5h} />}
      {showClaude && claude7d && <Metric label="7d" stat={claude7d} />}
      {showCodex && codex5h && <Metric label="CX 5h" stat={codex5h} />}
      {showCodex && codex7d && <Metric label="7d" stat={codex7d} />}
    </>
  );
}

function CompactMeter({ claude5h, claude7d, codex5h, codex7d, showClaude, showCodex }: MeterStatsProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {showClaude && claude5h && (
        <span style={{ color: compactColor(claude5h, claude7d) }}>
          CC {formatPct(claude5h.pct)}
          {claude7d ? `/${formatPct(claude7d.pct)}` : ""}
        </span>
      )}
      {showCodex && codex5h && (
        <span style={{ color: compactColor(codex5h, codex7d) }}>
          CX {formatPct(codex5h.pct)}
          {codex7d ? `/${formatPct(codex7d.pct)}` : ""}
        </span>
      )}
    </div>
  );
}

type MetricProps = {
  label: string;
  stat: WindowStat;
};

function Metric({ label, stat }: MetricProps) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span>{label}</span>
      <CellBar pct={stat.pct} />
      <span>{formatPct(stat.pct)}</span>
    </span>
  );
}

function CellBar({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const activeCells = clamped === 0 ? 0 : Math.max(1, Math.ceil(clamped / 20));
  const color = usageColor(pct);
  const danger = pct >= 95;

  return (
    <span style={{ display: "flex", alignItems: "center" }}>
      {[0, 1, 2, 3, 4].map((cell) => (
        <span
          key={cell}
          style={{
            width: 6,
            height: 6,
            marginRight: 1,
            background: cell < activeCells ? color : "var(--cmux-border)",
            animation: danger && cell < activeCells ? "cmux-usage-pulse 1s infinite" : undefined,
          }}
        />
      ))}
    </span>
  );
}

function useMeterMode(): MeterMode {
  const [mode, setMode] = useState<MeterMode>(() => readMeterMode());

  useEffect(() => {
    const update = () => setMode(readMeterMode());
    const compactQuery = window.matchMedia("(max-width: 900px)");
    const hiddenQuery = window.matchMedia("(max-width: 700px)");

    compactQuery.addEventListener("change", update);
    hiddenQuery.addEventListener("change", update);
    update();

    return () => {
      compactQuery.removeEventListener("change", update);
      hiddenQuery.removeEventListener("change", update);
    };
  }, []);

  return mode;
}

function readMeterMode(): MeterMode {
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

function usageColor(pct: number): string {
  if (pct >= 95) {
    return "var(--cmux-usage-danger)";
  }
  if (pct >= 80) {
    return "var(--cmux-usage-warn)";
  }
  return "var(--cmux-usage-ok)";
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

function formatPct(value: number): string {
  return `${Math.min(100, Math.max(0, value)).toFixed(value >= 10 ? 0 : 1)}%`;
}
