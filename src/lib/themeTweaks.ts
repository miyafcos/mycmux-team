import type {
  TerminalColors,
  ThemeDefinition,
  ThemeStatusColors,
  ThemeTweakColorKey,
  ThemeTweaks,
} from "../types";
import {
  DEFAULT_THEME_BACKGROUND,
  normalizeThemeBackground,
} from "./themeBackgrounds";
export {
  DEFAULT_THEME_BACKGROUND,
  THEME_BACKGROUND_PRESETS,
  isDefaultThemeBackground,
} from "./themeBackgrounds";
export type {
  ThemeBackgroundCategory,
  ThemeBackgroundPreset,
  ThemeBackgroundTone,
} from "./themeBackgrounds";

export interface ThemeTweakField {
  key: ThemeTweakColorKey;
  label: string;
}

export interface ThemeTweakGroup {
  id: string;
  label: string;
  fields: ThemeTweakField[];
}

export type ThemeTweakPresetColors = Partial<Record<ThemeTweakColorKey, string>>;

export interface ThemeTweakPreset {
  id: string;
  label: string;
  description: string;
  colorsByScheme: {
    dark: ThemeTweakPresetColors;
    light: ThemeTweakPresetColors;
  };
}

export const DEFAULT_THEME_TWEAKS: ThemeTweaks = {
  enabled: false,
  colors: {},
  background: DEFAULT_THEME_BACKGROUND,
};

export const THEME_TWEAK_PRESETS: ThemeTweakPreset[] = [
  {
    id: "clear-focus",
    label: "くっきり",
    description: "白黒差と選択色を強める",
    colorsByScheme: {
      dark: {
        "chrome.background": "#05070b",
        "chrome.surface": "#0b1020",
        "chrome.border": "#334155",
        "chrome.text": "#f8fafc",
        "chrome.textMuted": "#cbd5e1",
        "chrome.accent": "#38bdf8",
        "terminal.background": "#030712",
        "terminal.foreground": "#f8fafc",
        "terminal.cursor": "#f8fafc",
        "terminal.selectionBackground": "#164e63",
        "status.working": "#38bdf8",
        "status.waiting": "#fbbf24",
        notification: "#f59e0b",
      },
      light: {
        "chrome.background": "#f8fafc",
        "chrome.surface": "#ffffff",
        "chrome.border": "#94a3b8",
        "chrome.text": "#0f172a",
        "chrome.textMuted": "#334155",
        "chrome.accent": "#2563eb",
        "terminal.background": "#ffffff",
        "terminal.foreground": "#0f172a",
        "terminal.cursor": "#1e293b",
        "terminal.selectionBackground": "#bfdbfe",
        "status.working": "#2563eb",
        "status.waiting": "#b45309",
        notification: "#d97706",
      },
    },
  },
  {
    id: "deep-quiet",
    label: "落ち着き",
    description: "中立色で目立ち方を抑える",
    colorsByScheme: {
      dark: {
        "chrome.background": "#0b0d10",
        "chrome.surface": "#14171c",
        "chrome.border": "#2d333d",
        "chrome.text": "#e5e7eb",
        "chrome.textMuted": "#a3aab5",
        "chrome.accent": "#8aa4c8",
        "terminal.background": "#080a0d",
        "terminal.foreground": "#e2e8f0",
        "terminal.cursor": "#d7dde6",
        "terminal.selectionBackground": "#263241",
        "status.working": "#8aa4c8",
        "status.waiting": "#c6a15b",
        notification: "#c6a15b",
      },
      light: {
        "chrome.background": "#f6f7f9",
        "chrome.surface": "#ffffff",
        "chrome.border": "#d4d9e2",
        "chrome.text": "#202733",
        "chrome.textMuted": "#606a78",
        "chrome.accent": "#536f98",
        "terminal.background": "#fbfcfd",
        "terminal.foreground": "#252b34",
        "terminal.cursor": "#252b34",
        "terminal.selectionBackground": "#dbe5f2",
        "status.working": "#536f98",
        "status.waiting": "#9a7330",
        notification: "#9a7330",
      },
    },
  },
  {
    id: "soft-readable",
    label: "やわらか",
    description: "温かい土台で刺激を下げる",
    colorsByScheme: {
      dark: {
        "chrome.background": "#101113",
        "chrome.surface": "#181a1d",
        "chrome.border": "#30343a",
        "chrome.text": "#ece7df",
        "chrome.textMuted": "#bdb6aa",
        "chrome.accent": "#7dd3fc",
        "terminal.background": "#0c0d0f",
        "terminal.foreground": "#ece7df",
        "terminal.cursor": "#f0dcbf",
        "terminal.selectionBackground": "#26313a",
        "status.working": "#7dd3fc",
        "status.waiting": "#f6c76b",
        notification: "#f6c76b",
      },
      light: {
        "chrome.background": "#fbf7f1",
        "chrome.surface": "#fffdf8",
        "chrome.border": "#ded6c8",
        "chrome.text": "#302820",
        "chrome.textMuted": "#756c61",
        "chrome.accent": "#2f7da8",
        "terminal.background": "#fffaf2",
        "terminal.foreground": "#3a3128",
        "terminal.cursor": "#5f4c39",
        "terminal.selectionBackground": "#f1e2c8",
        "status.working": "#2f7da8",
        "status.waiting": "#a66a18",
        notification: "#a66a18",
      },
    },
  },
  {
    id: "warm-tools",
    label: "暖色",
    description: "操作色を橙系に寄せる",
    colorsByScheme: {
      dark: {
        "chrome.background": "#100b08",
        "chrome.surface": "#18110c",
        "chrome.border": "#3a2618",
        "chrome.text": "#f6eee7",
        "chrome.textMuted": "#cdb6a3",
        "chrome.accent": "#f97316",
        "terminal.background": "#0c0806",
        "terminal.foreground": "#f6eee7",
        "terminal.cursor": "#fed7aa",
        "terminal.selectionBackground": "#4a2a16",
        "status.working": "#fb923c",
        "status.waiting": "#facc15",
        notification: "#fb923c",
      },
      light: {
        "chrome.background": "#fff8f1",
        "chrome.surface": "#fffdf9",
        "chrome.border": "#e8c9ac",
        "chrome.text": "#342318",
        "chrome.textMuted": "#7a5c46",
        "chrome.accent": "#ea580c",
        "terminal.background": "#fffcf8",
        "terminal.foreground": "#342318",
        "terminal.cursor": "#7c2d12",
        "terminal.selectionBackground": "#fed7aa",
        "status.working": "#c2410c",
        "status.waiting": "#b7791f",
        notification: "#ea580c",
      },
    },
  },
  {
    id: "forest-moss",
    label: "森",
    description: "緑と土色で集中しやすい落ち着き",
    colorsByScheme: {
      dark: {
        "chrome.background": "#07110d",
        "chrome.surface": "#102019",
        "chrome.border": "#294235",
        "chrome.text": "#e8f3ec",
        "chrome.textMuted": "#a9c2b2",
        "chrome.accent": "#65c18c",
        "terminal.background": "#040c09",
        "terminal.foreground": "#e6f0e8",
        "terminal.cursor": "#9ee6b8",
        "terminal.selectionBackground": "#1d4b36",
        "status.working": "#65c18c",
        "status.waiting": "#d7b46a",
        notification: "#d7b46a",
        "terminal.yellow": "#d7b46a",
        "terminal.brightYellow": "#f0d58a",
      },
      light: {
        "chrome.background": "#f3f8f1",
        "chrome.surface": "#ffffff",
        "chrome.border": "#bed2c2",
        "chrome.text": "#17251c",
        "chrome.textMuted": "#526557",
        "chrome.accent": "#2f7d4f",
        "terminal.background": "#fbfdf8",
        "terminal.foreground": "#1c2a20",
        "terminal.cursor": "#23583a",
        "terminal.selectionBackground": "#d8ead9",
        "status.working": "#2f7d4f",
        "status.waiting": "#8b6b22",
        notification: "#8b6b22",
        "terminal.yellow": "#8b6b22",
        "terminal.brightYellow": "#b48a2c",
      },
    },
  },
  {
    id: "sakura-ink",
    label: "桜",
    description: "淡い桃色と墨色でやわらかく変える",
    colorsByScheme: {
      dark: {
        "chrome.background": "#140b12",
        "chrome.surface": "#21131d",
        "chrome.border": "#4a2b40",
        "chrome.text": "#f8edf4",
        "chrome.textMuted": "#d2afc4",
        "chrome.accent": "#f08ab8",
        "terminal.background": "#0f080d",
        "terminal.foreground": "#f4e8ef",
        "terminal.cursor": "#f6b8d2",
        "terminal.selectionBackground": "#563149",
        "status.working": "#f08ab8",
        "status.waiting": "#f0c36b",
        notification: "#f08ab8",
        "terminal.yellow": "#f0c36b",
        "terminal.brightYellow": "#f7d992",
      },
      light: {
        "chrome.background": "#fff6fa",
        "chrome.surface": "#ffffff",
        "chrome.border": "#e8c4d6",
        "chrome.text": "#2d1d26",
        "chrome.textMuted": "#7a5a6a",
        "chrome.accent": "#c64f82",
        "terminal.background": "#fffbfd",
        "terminal.foreground": "#2d1d26",
        "terminal.cursor": "#a63d6b",
        "terminal.selectionBackground": "#f5d7e6",
        "status.working": "#c64f82",
        "status.waiting": "#9b6b17",
        notification: "#c64f82",
        "terminal.yellow": "#9b6b17",
        "terminal.brightYellow": "#c78a26",
      },
    },
  },
  {
    id: "paper-ink",
    label: "紙と墨",
    description: "紙面のような背景と強い文字色",
    colorsByScheme: {
      dark: {
        "chrome.background": "#11100d",
        "chrome.surface": "#1c1914",
        "chrome.border": "#3f392f",
        "chrome.text": "#f4ead8",
        "chrome.textMuted": "#c9bca6",
        "chrome.accent": "#a78bfa",
        "terminal.background": "#0c0b09",
        "terminal.foreground": "#f3eadb",
        "terminal.cursor": "#f3eadb",
        "terminal.selectionBackground": "#3b3448",
        "status.working": "#a78bfa",
        "status.waiting": "#d6a84f",
        notification: "#d6a84f",
        "terminal.yellow": "#d6a84f",
        "terminal.brightYellow": "#edc86f",
      },
      light: {
        "chrome.background": "#fbf1df",
        "chrome.surface": "#fffaf0",
        "chrome.border": "#d8c4a5",
        "chrome.text": "#211a12",
        "chrome.textMuted": "#665946",
        "chrome.accent": "#6d4bd1",
        "terminal.background": "#fff8ea",
        "terminal.foreground": "#211a12",
        "terminal.cursor": "#211a12",
        "terminal.selectionBackground": "#e7d9f7",
        "status.working": "#6d4bd1",
        "status.waiting": "#875b12",
        notification: "#875b12",
        "terminal.yellow": "#875b12",
        "terminal.brightYellow": "#ad7418",
      },
    },
  },
  {
    id: "aqua-glass",
    label: "水面",
    description: "青緑と淡い光で軽い印象にする",
    colorsByScheme: {
      dark: {
        "chrome.background": "#061018",
        "chrome.surface": "#0d1c25",
        "chrome.border": "#244657",
        "chrome.text": "#e5f7fb",
        "chrome.textMuted": "#a6cbd4",
        "chrome.accent": "#22d3ee",
        "terminal.background": "#030b10",
        "terminal.foreground": "#e1f5f9",
        "terminal.cursor": "#67e8f9",
        "terminal.selectionBackground": "#164e63",
        "status.working": "#22d3ee",
        "status.waiting": "#f3ca5b",
        notification: "#22d3ee",
        "terminal.yellow": "#f3ca5b",
        "terminal.brightYellow": "#f8df82",
      },
      light: {
        "chrome.background": "#effbfc",
        "chrome.surface": "#ffffff",
        "chrome.border": "#b7dce3",
        "chrome.text": "#10242b",
        "chrome.textMuted": "#4d6a72",
        "chrome.accent": "#0e7490",
        "terminal.background": "#f8feff",
        "terminal.foreground": "#10242b",
        "terminal.cursor": "#0f5f73",
        "terminal.selectionBackground": "#cdeff5",
        "status.working": "#0e7490",
        "status.waiting": "#9a6b11",
        notification: "#0e7490",
        "terminal.yellow": "#9a6b11",
        "terminal.brightYellow": "#c88a1c",
      },
    },
  },
  {
    id: "mono-contrast",
    label: "モノ",
    description: "彩度を抑えて文字と境界を強く読む",
    colorsByScheme: {
      dark: {
        "chrome.background": "#0b0b0b",
        "chrome.surface": "#171717",
        "chrome.border": "#3f3f46",
        "chrome.text": "#f4f4f5",
        "chrome.textMuted": "#a1a1aa",
        "chrome.accent": "#84cc16",
        "terminal.background": "#050505",
        "terminal.foreground": "#f4f4f5",
        "terminal.cursor": "#a3e635",
        "terminal.selectionBackground": "#2f3a25",
        "status.working": "#84cc16",
        "status.waiting": "#eab308",
        notification: "#84cc16",
        "terminal.yellow": "#eab308",
        "terminal.brightYellow": "#facc15",
      },
      light: {
        "chrome.background": "#f7f7f4",
        "chrome.surface": "#ffffff",
        "chrome.border": "#c9c9c2",
        "chrome.text": "#1c1c1a",
        "chrome.textMuted": "#61615c",
        "chrome.accent": "#4d7c0f",
        "terminal.background": "#fcfcf8",
        "terminal.foreground": "#1c1c1a",
        "terminal.cursor": "#3f6212",
        "terminal.selectionBackground": "#e0eac7",
        "status.working": "#4d7c0f",
        "status.waiting": "#9a6b11",
        notification: "#4d7c0f",
        "terminal.yellow": "#9a6b11",
        "terminal.brightYellow": "#c88a1c",
      },
    },
  },
  {
    id: "coral-studio",
    label: "珊瑚",
    description: "白黒に珊瑚色を効かせた制作向き",
    colorsByScheme: {
      dark: {
        "chrome.background": "#120f10",
        "chrome.surface": "#20191b",
        "chrome.border": "#493236",
        "chrome.text": "#f7eeec",
        "chrome.textMuted": "#cbb8b4",
        "chrome.accent": "#ff7a59",
        "terminal.background": "#0d090a",
        "terminal.foreground": "#f7eeec",
        "terminal.cursor": "#ff9f80",
        "terminal.selectionBackground": "#5b2d24",
        "status.working": "#ff7a59",
        "status.waiting": "#f2c66d",
        notification: "#ff7a59",
        "terminal.yellow": "#f2c66d",
        "terminal.brightYellow": "#fde08d",
      },
      light: {
        "chrome.background": "#fff7f3",
        "chrome.surface": "#ffffff",
        "chrome.border": "#e6c5bb",
        "chrome.text": "#2a1f1c",
        "chrome.textMuted": "#735e57",
        "chrome.accent": "#d84b2a",
        "terminal.background": "#fffdfb",
        "terminal.foreground": "#2a1f1c",
        "terminal.cursor": "#a9381e",
        "terminal.selectionBackground": "#ffd9ce",
        "status.working": "#d84b2a",
        "status.waiting": "#9b6b17",
        notification: "#d84b2a",
        "terminal.yellow": "#9b6b17",
        "terminal.brightYellow": "#c78a26",
      },
    },
  },
  {
    id: "fuji-mint",
    label: "藤",
    description: "藤色にミントを合わせて少し華やか",
    colorsByScheme: {
      dark: {
        "chrome.background": "#130f1d",
        "chrome.surface": "#211a30",
        "chrome.border": "#463a62",
        "chrome.text": "#f1edf8",
        "chrome.textMuted": "#c3b6d8",
        "chrome.accent": "#a78bfa",
        "terminal.background": "#0c0913",
        "terminal.foreground": "#eee9f6",
        "terminal.cursor": "#6ee7b7",
        "terminal.selectionBackground": "#3e315a",
        "status.working": "#6ee7b7",
        "status.waiting": "#f2c66d",
        notification: "#a78bfa",
        "terminal.yellow": "#f2c66d",
        "terminal.brightYellow": "#fde08d",
      },
      light: {
        "chrome.background": "#faf7ff",
        "chrome.surface": "#ffffff",
        "chrome.border": "#d9caef",
        "chrome.text": "#251f2f",
        "chrome.textMuted": "#6b5a82",
        "chrome.accent": "#7c3aed",
        "terminal.background": "#fffbff",
        "terminal.foreground": "#251f2f",
        "terminal.cursor": "#0f9f7a",
        "terminal.selectionBackground": "#e8dbfb",
        "status.working": "#0f9f7a",
        "status.waiting": "#9b6b17",
        notification: "#7c3aed",
        "terminal.yellow": "#9b6b17",
        "terminal.brightYellow": "#c78a26",
      },
    },
  },
  {
    id: "graphite-amber",
    label: "黒鉛",
    description: "黒鉛グレーに琥珀を足して締まった印象",
    colorsByScheme: {
      dark: {
        "chrome.background": "#0e0f10",
        "chrome.surface": "#1a1b1d",
        "chrome.border": "#3a3d42",
        "chrome.text": "#f1f2f4",
        "chrome.textMuted": "#aeb4bd",
        "chrome.accent": "#f59e0b",
        "terminal.background": "#08090a",
        "terminal.foreground": "#edf0f2",
        "terminal.cursor": "#fbbf24",
        "terminal.selectionBackground": "#3f3421",
        "status.working": "#f59e0b",
        "status.waiting": "#93c5fd",
        notification: "#f59e0b",
        "terminal.yellow": "#f59e0b",
        "terminal.brightYellow": "#fbbf24",
      },
      light: {
        "chrome.background": "#f4f5f6",
        "chrome.surface": "#ffffff",
        "chrome.border": "#c7cbd1",
        "chrome.text": "#1b1d20",
        "chrome.textMuted": "#5d646e",
        "chrome.accent": "#b45309",
        "terminal.background": "#fbfbfc",
        "terminal.foreground": "#1b1d20",
        "terminal.cursor": "#92400e",
        "terminal.selectionBackground": "#ffe2b8",
        "status.working": "#b45309",
        "status.waiting": "#2563eb",
        notification: "#b45309",
        "terminal.yellow": "#b45309",
        "terminal.brightYellow": "#d97706",
      },
    },
  },
];

export const THEME_TWEAK_PRESET_SCOPE: ThemeTweakColorKey[] = [
  "chrome.background",
  "chrome.surface",
  "chrome.border",
  "chrome.text",
  "chrome.textMuted",
  "chrome.accent",
  "terminal.background",
  "terminal.foreground",
  "terminal.cursor",
  "terminal.selectionBackground",
  "status.working",
  "status.waiting",
  "notification",
  "terminal.yellow",
  "terminal.brightYellow",
];

export const THEME_TWEAK_GROUPS: ThemeTweakGroup[] = [
  {
    id: "chrome",
    label: "画面の土台",
    fields: [
      { key: "chrome.background", label: "全体の背景" },
      { key: "chrome.surface", label: "パネル/サイドバー" },
      { key: "chrome.border", label: "境界線" },
      { key: "chrome.text", label: "メイン文字" },
      { key: "chrome.textMuted", label: "補助文字" },
      { key: "chrome.textDim", label: "薄い文字" },
      { key: "chrome.accent", label: "選択/アクセント" },
      { key: "chrome.danger", label: "警告/削除" },
    ],
  },
  {
    id: "terminal-base",
    label: "端末の土台",
    fields: [
      { key: "terminal.background", label: "背景" },
      { key: "terminal.foreground", label: "文字" },
      { key: "terminal.cursor", label: "カーソル" },
      { key: "terminal.selectionBackground", label: "選択範囲" },
    ],
  },
  {
    id: "terminal-normal",
    label: "端末の基本色",
    fields: [
      { key: "terminal.black", label: "黒" },
      { key: "terminal.red", label: "赤" },
      { key: "terminal.green", label: "緑" },
      { key: "terminal.yellow", label: "黄" },
      { key: "terminal.blue", label: "青" },
      { key: "terminal.magenta", label: "紫" },
      { key: "terminal.cyan", label: "水色" },
      { key: "terminal.white", label: "白" },
    ],
  },
  {
    id: "terminal-bright",
    label: "端末の明るい色",
    fields: [
      { key: "terminal.brightBlack", label: "明るい黒" },
      { key: "terminal.brightRed", label: "明るい赤" },
      { key: "terminal.brightGreen", label: "明るい緑" },
      { key: "terminal.brightYellow", label: "明るい黄" },
      { key: "terminal.brightBlue", label: "明るい青" },
      { key: "terminal.brightMagenta", label: "明るい紫" },
      { key: "terminal.brightCyan", label: "明るい水色" },
      { key: "terminal.brightWhite", label: "明るい白" },
    ],
  },
  {
    id: "status",
    label: "状態と通知",
    fields: [
      { key: "status.working", label: "作業中ランプ" },
      { key: "status.waiting", label: "承認待ちランプ" },
      { key: "status.done", label: "完了ランプ" },
      { key: "status.error", label: "エラーランプ" },
      { key: "notification", label: "通知バッジ" },
    ],
  },
];

const TWEAK_KEYS = new Set<ThemeTweakColorKey>(
  THEME_TWEAK_GROUPS.flatMap((group) => group.fields.map((field) => field.key)),
);

export function normalizeThemeColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    return `#${short[1]
      .split("")
      .map((char) => `${char}${char}`)
      .join("")}`.toLowerCase();
  }

  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return null;
}

export function normalizeThemeTweaks(input: unknown): ThemeTweaks {
  const record = toRecord(input);
  if (!record) {
    return DEFAULT_THEME_TWEAKS;
  }

  const colorsRecord = toRecord(record.colors);
  const colors: Partial<Record<ThemeTweakColorKey, string>> = {};
  if (colorsRecord) {
    for (const [rawKey, rawValue] of Object.entries(colorsRecord)) {
      if (!isThemeTweakColorKey(rawKey)) {
        continue;
      }
      const color = normalizeThemeColor(rawValue);
      if (color) {
        colors[rawKey] = color;
      }
    }
  }

  return {
    enabled: record.enabled === true || Object.keys(colors).length > 0,
    colors,
    background: normalizeThemeBackground(record.background),
  };
}

export function applyThemeTweaks(theme: ThemeDefinition, input: unknown): ThemeDefinition {
  const tweaks = normalizeThemeTweaks(input);
  if (!tweaks.enabled) {
    return theme;
  }

  return Object.entries(tweaks.colors).reduce<ThemeDefinition>(
    (nextTheme, [key, color]) => withThemeColor(nextTheme, key as ThemeTweakColorKey, color),
    theme,
  );
}

export function readThemeColor(theme: ThemeDefinition, key: ThemeTweakColorKey): string {
  if (key === "notification") {
    return theme.notification;
  }

  const [section, name] = key.split(".") as [
    "chrome" | "terminal" | "status",
    string,
  ];
  if (section === "chrome") {
    return theme.chrome[name as keyof ThemeDefinition["chrome"]];
  }
  if (section === "terminal") {
    return theme.terminal[name as keyof TerminalColors];
  }
  return theme.status[name as keyof ThemeStatusColors];
}

export function hasThemeTweak(tweaks: ThemeTweaks, key: ThemeTweakColorKey): boolean {
  return Object.prototype.hasOwnProperty.call(tweaks.colors, key);
}

export function getThemeTweakPresetColors(
  preset: ThemeTweakPreset,
  theme: ThemeDefinition,
): ThemeTweakPresetColors {
  return preset.colorsByScheme[theme.colorScheme];
}

function withThemeColor(
  theme: ThemeDefinition,
  key: ThemeTweakColorKey,
  color: string,
): ThemeDefinition {
  if (key === "notification") {
    return { ...theme, notification: color };
  }

  const [section, name] = key.split(".") as [
    "chrome" | "terminal" | "status",
    string,
  ];

  if (section === "chrome") {
    return {
      ...theme,
      chrome: {
        ...theme.chrome,
        [name]: color,
      },
    };
  }

  if (section === "terminal") {
    return {
      ...theme,
      terminal: {
        ...theme.terminal,
        [name]: color,
      },
    };
  }

  return {
    ...theme,
    status: {
      ...theme.status,
      [name]: color,
    },
  };
}

function isThemeTweakColorKey(value: string): value is ThemeTweakColorKey {
  return TWEAK_KEYS.has(value as ThemeTweakColorKey);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
