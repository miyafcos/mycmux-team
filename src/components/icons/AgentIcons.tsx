import { useId } from "react";
import type { CSSProperties, SVGProps } from "react";

type AgentIconProps = Omit<SVGProps<SVGSVGElement>, "height" | "width"> & {
  size?: number;
};

type AgentKindIconProps = {
  kind?: string | null;
  size?: number;
  chip?: boolean;
};

const iconProps = (size: number): SVGProps<SVGSVGElement> => ({
  "aria-hidden": true,
  focusable: "false",
  width: size,
  height: size,
  viewBox: "0 0 24 24",
});

export function ClaudeAgentIcon({ size = 12, ...props }: AgentIconProps) {
  return (
    <svg {...iconProps(size)} {...props}>
      <path fill="#d97757" fillRule="evenodd" clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0v-3.1h3V5h17.998zM6 10.949h1.488V8.102H6zm10.51 0H18V8.102h-1.49z" />
    </svg>
  );
}

export function CodexAgentIcon({ size = 12, ...props }: AgentIconProps) {
  const gradientId = useId();
  return (
    <svg {...iconProps(size)} {...props}>
      <defs>
        <linearGradient id={gradientId} x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#b1a7ff" />
          <stop offset="50%" stopColor="#7a9dff" />
          <stop offset="100%" stopColor="#3941ff" />
        </linearGradient>
      </defs>
      <path fill="#fff" d="M19.503 0H4.496A4.496 4.496 0 0 0 0 4.496v15.007A4.496 4.496 0 0 0 4.496 24h15.007A4.496 4.496 0 0 0 24 19.503V4.496A4.496 4.496 0 0 0 19.503 0" />
      <path fill={`url(#${gradientId})`} d="M9.064 3.344a4.6 4.6 0 0 1 2.285-.312q1.5.173 2.673 1.275.016.015.037.021a.1.1 0 0 0 .043 0 4.55 4.55 0 0 1 3.046.275l.047.022.116.057a4.58 4.58 0 0 1 2.188 2.399q.313.765.315 1.595a4.2 4.2 0 0 1-.134 1.223.12.12 0 0 0 .03.115q.89.91 1.183 2.17.433 2.138-.887 3.854l-.136.166a4.55 4.55 0 0 1-2.201 1.388.12.12 0 0 0-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838q-1.78-.009-3.157-1.302a.11.11 0 0 0-.105-.024c-.388.125-.78.143-1.204.138a4.44 4.44 0 0 1-1.945-.466 4.54 4.54 0 0 1-1.61-1.335c-.152-.202-.303-.392-.414-.617a6 6 0 0 1-.37-.961 4.6 4.6 0 0 1-.014-2.298.1.1 0 0 0 .006-.056.1.1 0 0 0-.027-.048 4.5 4.5 0 0 1-1.034-1.651 3.9 3.9 0 0 1-.251-1.192 5.2 5.2 0 0 1 .141-1.6Q3.659 7.92 5.086 6.97q.318-.212.601-.33a6 6 0 0 1 .646-.227.1.1 0 0 0 .065-.066 4.5 4.5 0 0 1 .829-1.615 4.54 4.54 0 0 1 1.837-1.388m3.482 10.565a.637.637 0 0 0 0 1.272h3.636a.637.637 0 1 0 0-1.272zM8.462 9.23a.637.637 0 0 0-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 1 0 1.095.649l1.454-2.455a.64.64 0 0 0 .005-.64z" />
    </svg>
  );
}

// Official Grok mark on a white plate, the same treatment the Codex icon uses so
// the black glyph stays readable in both themes.
export function GrokAgentIcon({ size = 12, ...props }: AgentIconProps) {
  return (
    <svg {...iconProps(size)} {...props}>
      <rect width="24" height="24" rx="4.5" fill="#fff" />
      <g transform="translate(2.4 2.4) scale(.8)">
        <path fill="#000" fillRule="evenodd" clipRule="evenodd" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
      </g>
    </svg>
  );
}

export function AntigravityAgentIcon({ size = 14 }: { size?: number }) {
  const gid = useId();
  const d = "M3 20.5 C8.5 19.5 9.5 6.5 12 6.5 C14.5 6.5 15.5 19.5 21 20.5";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${gid}-x`} x1="3" y1="12" x2="21" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3087fa" />
          <stop offset="0.35" stopColor="#57b657" />
          <stop offset="0.6" stopColor="#f6863a" />
          <stop offset="0.8" stopColor="#e25652" />
          <stop offset="1" stopColor="#7b7bcc" />
        </linearGradient>
        <linearGradient id={`${gid}-y`} x1="12" y1="22" x2="12" y2="8" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3087fa" />
          <stop offset="0.45" stopColor="#3087fa" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={d} stroke={`url(#${gid}-x)`} strokeWidth="4.6" strokeLinecap="round" />
      <path d={d} stroke={`url(#${gid}-y)`} strokeWidth="4.6" strokeLinecap="round" />
    </svg>
  );
}

// Google's four-point spark. Antigravity ships its own mark (the arch above),
// so the web Gemini row cannot borrow it — the two products read as one brand
// otherwise. Drawn on the transparent ground the spark is designed for; its own
// gradient carries enough contrast for both themes.
export function GeminiAgentIcon({ size = 12, ...props }: AgentIconProps) {
  const gradientId = useId();
  return (
    <svg {...iconProps(size)} {...props}>
      <defs>
        <linearGradient id={gradientId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4285f4" />
          <stop offset="50%" stopColor="#9b72cb" />
          <stop offset="100%" stopColor="#d96570" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
      />
    </svg>
  );
}

// NotebookLM on its own plate, the treatment Codex and Grok use, so the mark
// keeps its contrast whichever theme the pane is painted in. The glyph is a
// bound notebook with a turned page — approximated from the product mark, which
// ships no public SVG.
export function NotebookLmAgentIcon({ size = 12, ...props }: AgentIconProps) {
  const gradientId = useId();
  return (
    <svg {...iconProps(size)} {...props}>
      <defs>
        <linearGradient id={gradientId} x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4285f4" />
          <stop offset="100%" stopColor="#9b72cb" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="5" fill={`url(#${gradientId})`} />
      <path fill="#fff" d="M8.4 5.4h6l3.6 3.6v8.05a1.55 1.55 0 0 1-1.55 1.55H8.4a1.55 1.55 0 0 1-1.55-1.55V6.95A1.55 1.55 0 0 1 8.4 5.4m5.5 1.5v2.75h2.75z" />
      <rect x="5" y="5.4" width="1.5" height="13.2" rx=".75" fill="#fff" opacity=".55" />
    </svg>
  );
}

export function BrowserAgentIcon({ size = 12, ...props }: AgentIconProps) {
  return (
    <svg {...iconProps(size)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M4 8h16" />
      <path d="M4 16h16" />
    </svg>
  );
}

// Hermes ships a caduceus (☤) as its mark; this is a stroked approximation --
// the staff, the winged crest and the two coils -- so it reads at 12px.
export function HermesAgentIcon({ size = 12, ...props }: AgentIconProps) {
  return (
    <svg {...iconProps(size)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 5.5v14" />
      <path d="M7.5 7.5c1.6-1.7 3-1.7 4.5 0s2.9 1.7 4.5 0" />
      <path d="M8.5 12c1.2 1.3 2.3 2 3.5 2s2.3-.7 3.5-2" />
      <circle cx="12" cy="3.6" r="1.5" />
    </svg>
  );
}

export function HybridAgentIcon({ size = 12 }: Pick<AgentIconProps, "size">) {
  const overlapSize = Math.max(1, Math.round(size * 0.68));
  return (
    <span aria-hidden="true" style={{ position: "relative", display: "inline-block", width: size, height: size, flexShrink: 0 }}>
      <span style={{ position: "absolute", left: "5%", top: "5%", lineHeight: 0 }}>
        <ClaudeAgentIcon size={overlapSize} />
      </span>
      <span style={{ position: "absolute", right: "5%", bottom: "5%", lineHeight: 0 }}>
        <CodexAgentIcon size={overlapSize} />
      </span>
    </span>
  );
}

const chipStyles: Record<string, CSSProperties> = {
  claude: { background: "rgba(217,119,87,.12)", borderColor: "rgba(217,119,87,.30)" },
  codex: { background: "rgba(122,157,255,.10)", borderColor: "rgba(122,157,255,.30)" },
  "claude-codex": { background: "rgba(125,204,151,.10)", borderColor: "rgba(125,204,151,.30)" },
  grok: { background: "rgba(243,139,168,.10)", borderColor: "rgba(243,139,168,.30)" },
  antigravity: { background: "rgba(66,133,244,.10)", borderColor: "rgba(66,133,244,.30)" },
  gemini: { background: "rgba(155,114,203,.12)", borderColor: "rgba(155,114,203,.30)" },
  notebooklm: { background: "rgba(66,133,244,.10)", borderColor: "rgba(66,133,244,.30)" },
  hermes: { background: "rgba(198,152,26,.12)", borderColor: "rgba(198,152,26,.32)" },
};

export function AgentKindIcon({ kind, size = 14, chip = true }: AgentKindIconProps) {
  const Icon = kind === "claude"
    ? ClaudeAgentIcon
    : kind === "codex"
      ? CodexAgentIcon
      : kind === "claude-codex"
        ? HybridAgentIcon
        : kind === "grok"
          ? GrokAgentIcon
        : kind === "antigravity"
          ? AntigravityAgentIcon
        : kind === "gemini"
          ? GeminiAgentIcon
        : kind === "notebooklm"
          ? NotebookLmAgentIcon
        : kind === "browser"
          ? BrowserAgentIcon
        : kind === "hermes"
          ? HermesAgentIcon
          : null;

  if (!Icon) return null;
  if (!chip) return <Icon size={size} />;
  const chipStyle = chipStyles[kind ?? ""];

  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        boxSizing: "border-box",
        border: "1px solid transparent",
        borderRadius: 5,
        flexShrink: 0,
        lineHeight: 0,
        ...chipStyle,
      }}
    >
      <Icon size={Math.max(1, Math.round(size * 0.82))} />
    </span>
  );
}
