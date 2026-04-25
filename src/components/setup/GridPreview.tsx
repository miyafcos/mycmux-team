import type { GridTemplate } from "../../types";

interface GridPreviewProps {
  template: GridTemplate;
  selected: boolean;
  onClick: () => void;
}

export default function GridPreview({ template, selected, onClick }: GridPreviewProps) {
  const size = 56;
  const gap = 2;
  const cellW = (size - gap * (template.cols - 1)) / template.cols;
  const cellH = (size - gap * (template.rows - 1)) / template.rows;

  const cells: { x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < template.rows; r++) {
    for (let c = 0; c < template.cols; c++) {
      cells.push({
        x: c * (cellW + gap),
        y: r * (cellH + gap),
        w: cellW,
        h: cellH,
      });
    }
  }

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: 8,
        background: selected ? "var(--cmux-selected)" : "var(--cmux-surface)",
        border: selected ? "1px solid var(--cmux-accent)" : "1px solid var(--cmux-border)",
        borderRadius: 6,
        cursor: "pointer",
        transition: "border-color 0.15s",
      }}
    >
      <svg width={size} height={size}>
        {cells.map((cell, i) => (
          <rect
            key={i}
            x={cell.x}
            y={cell.y}
            width={cell.w}
            height={cell.h}
            rx={2}
            fill={selected ? "var(--cmux-accent)" : "var(--cmux-text-tertiary)"}
            opacity={selected ? 0.6 : 0.4}
          />
        ))}
      </svg>
      <span
        style={{
          fontSize: 10,
          color: selected ? "var(--cmux-accent)" : "var(--cmux-text-tertiary)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {template.label}
      </span>
    </button>
  );
}
