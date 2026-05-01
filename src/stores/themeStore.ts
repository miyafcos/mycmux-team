import { create } from "zustand";
import type { ThemeDefinition } from "../types";
import { DEFAULT_THEME_ID, getTheme, resolveThemeId } from "../components/theme/themeDefinitions";

export interface TerminalFontPreset {
  id: string;
  label: string;
  value: string;
  sample: string;
  description: string;
  tags: string[];
}

export const DEFAULT_TERMINAL_FONT_FAMILY =
  "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Geist Mono', 'SF Mono', 'BIZ UDGothic', 'MS Gothic', monospace";

const LEGACY_CASCADIA_FONT_FAMILY =
  "'Cascadia Mono', 'Cascadia Code', 'BIZ UDGothic', 'MS Gothic', monospace";
const LEGACY_CONSOLAS_FONT_FAMILY = "Consolas, 'BIZ UDGothic', 'MS Gothic', monospace";
const LEGACY_MEIRYO_FONT_FAMILY = "'Meiryo', 'Meiryo UI', 'BIZ UDGothic', 'Cascadia Mono', monospace";
const LEGACY_YU_GOTHIC_FONT_FAMILY = "'Yu Gothic UI', 'Yu Gothic', 'BIZ UDGothic', 'Cascadia Mono', monospace";
const HG_GOTHIC_FONT_FAMILY = "'HGｺﾞｼｯｸM', 'HGPｺﾞｼｯｸM', 'BIZ UDGothic', 'MS Gothic', monospace";
const BIZ_UDMINCHO_FONT_FAMILY =
  "'BIZ UDMincho', 'BIZ UDPMincho', 'Yu Mincho', 'MS Mincho', 'BIZ UDGothic', monospace";

export const TERMINAL_FONT_PRESETS: TerminalFontPreset[] = [
  {
    id: "jetbrains-ja",
    label: "JetBrains + 日本語",
    value: DEFAULT_TERMINAL_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "英数が締まり、日本語 fallback も崩れにくい標準",
    tags: ["標準", "英数くっきり", "日本語OK"],
  },
  {
    id: "biz-readable",
    label: "BIZ UDゴシック",
    value: "'BIZ UDGothic', 'Cascadia Mono', 'JetBrains Mono', 'MS Gothic', monospace",
    sample: "Aa 0123 日本語",
    description: "日本語が太めで、長文や説明文を追いやすい",
    tags: ["日本語重視", "太め", "読みやすい"],
  },
  {
    id: "hg-gothic-m",
    label: "HGゴシックM",
    value: HG_GOTHIC_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "少し太めの日本語ゴシック。細すぎず、画面上で文字を追いやすい",
    tags: ["日本語", "太め", "見やすい"],
  },
  {
    id: "ms-gothic",
    label: "MSゴシック",
    value: "'MS Gothic', 'BIZ UDGothic', monospace",
    sample: "Aa 0123 日本語",
    description: "昔ながらの完全等幅寄りで、日本語表の列が揃いやすい",
    tags: ["等幅", "表", "日本語"],
  },
  {
    id: "ud-kyokasho",
    label: "UD 教科書体",
    value: "'UD Digi Kyokasho N-R', 'UD Digi Kyokasho N', 'BIZ UDGothic', 'MS Gothic', monospace",
    sample: "Aa 0123 日本語",
    description: "日本語の形がやわらかく、説明文の雰囲気が大きく変わる",
    tags: ["日本語きれい", "雰囲気", "本文向き"],
  },
  {
    id: "biz-udmincho",
    label: "BIZ UD明朝",
    value: BIZ_UDMINCHO_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "明朝系で雰囲気が大きく変わり、文章が落ち着いて見える",
    tags: ["明朝", "上品", "文章"],
  },
];

interface ThemeState {
  themeId: string;
  theme: ThemeDefinition;
  fontSize: number;
  fontFamily: string;

  setTheme: (id: string) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (fontFamily: string) => void;
  hydrateSettings: (settings: { themeId?: string; fontSize?: number; fontFamily?: unknown }) => void;
}

function normalizeFontFamily(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 180 || /[\r\n]/.test(trimmed)) {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  if (
    trimmed === LEGACY_CASCADIA_FONT_FAMILY ||
    trimmed === LEGACY_MEIRYO_FONT_FAMILY ||
    trimmed === LEGACY_YU_GOTHIC_FONT_FAMILY
  ) {
    return HG_GOTHIC_FONT_FAMILY;
  }
  if (trimmed === LEGACY_CONSOLAS_FONT_FAMILY) {
    return BIZ_UDMINCHO_FONT_FAMILY;
  }
  return trimmed;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: DEFAULT_THEME_ID,
  theme: getTheme(DEFAULT_THEME_ID),
  fontSize: 14,
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,

  setTheme: (id) => {
    const nextThemeId = resolveThemeId(id);
    const theme = getTheme(nextThemeId);
    set({ themeId: nextThemeId, theme });
  },

  setFontSize: (fontSize) => {
    set({ fontSize: Math.max(10, Math.min(24, fontSize)) });
  },

  setFontFamily: (fontFamily) => {
    set({ fontFamily: normalizeFontFamily(fontFamily) });
  },

  hydrateSettings: (settings) => {
    const nextThemeId = resolveThemeId(settings.themeId ?? DEFAULT_THEME_ID);
    const nextTheme = getTheme(nextThemeId);
    const nextFont = typeof settings.fontSize === "number"
      ? Math.max(10, Math.min(24, settings.fontSize))
      : 14;
    const nextFontFamily = normalizeFontFamily(settings.fontFamily);
    set({
      themeId: nextThemeId,
      theme: nextTheme,
      fontSize: nextFont,
      fontFamily: nextFontFamily,
    });
  },
}));
