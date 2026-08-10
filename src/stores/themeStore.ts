import { create } from "zustand";
import type { ThemeBackgroundSettings, ThemeDefinition, ThemeTweakColorKey, ThemeTweaks } from "../types";
import { DEFAULT_THEME_ID, getTheme, resolveThemeId } from "../components/theme/themeDefinitions";
import {
  DEFAULT_THEME_TWEAKS,
  THEME_TWEAK_GROUPS,
  THEME_TWEAK_PRESET_SCOPE,
  applyThemeTweaks,
  normalizeThemeColor,
  normalizeThemeTweaks,
  readThemeColor,
} from "../lib/themeTweaks";

export interface TerminalFontPreset {
  id: string;
  label: string;
  value: string;
  sample: string;
  description: string;
  tags: string[];
  recommendedLineHeight?: number;
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
const MAC_STYLE_FONT_FAMILY =
  "'SF Mono', 'Menlo', 'Monaco', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'BIZ UDGothic', 'Yu Gothic UI', monospace";
const CASCADIA_BIZ_FONT_FAMILY =
  "'Cascadia Code', 'Cascadia Mono', 'BIZ UDGothic', 'Yu Gothic UI', 'MS Gothic', monospace";
const CONSOLAS_MEIRYO_FONT_FAMILY =
  "Consolas, 'Meiryo UI', Meiryo, 'BIZ UDGothic', 'MS Gothic', monospace";

export const TERMINAL_FONT_PRESETS: TerminalFontPreset[] = [
  {
    id: "jetbrains-ja",
    label: "JetBrains + 日本語",
    value: DEFAULT_TERMINAL_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "標準。英数字が締まり、日本語も安定",
    tags: ["標準", "コード"],
    recommendedLineHeight: 1.35,
  },
  {
    id: "udev-gothic",
    label: "UDEV Gothic",
    value: "'UDEV Gothic NF', 'UDEV Gothic', 'BIZ UDGothic', 'MS Gothic', monospace",
    sample: "Aa 0123 日本語",
    description: "ターミナル専用。日本語=BIZ UDゴシック、英数字=JetBrains Mono",
    tags: ["日本語", "コード", "標準"],
    recommendedLineHeight: 1.35,
  },
  {
    id: "udev-gothic-35",
    label: "UDEV Gothic 35",
    value: "'UDEV Gothic 35NF', 'UDEV Gothic 35', 'BIZ UDGothic', 'MS Gothic', monospace",
    sample: "Aa 0123 日本語",
    description: "英数字が幅広の UDEV。英語ログ・パスが読みやすい",
    tags: ["日本語", "コード"],
    recommendedLineHeight: 1.4,
  },
  {
    id: "cascadia-biz",
    label: "Cascadia + BIZ",
    value: CASCADIA_BIZ_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "丸み。Windows Terminal風で数字も読みやすい",
    tags: ["コード", "Windows"],
    recommendedLineHeight: 1.35,
  },
  {
    id: "consolas-meiryo",
    label: "Consolas + メイリオ",
    value: CONSOLAS_MEIRYO_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "軽め。古典的IDE風で画面に余白が出る",
    tags: ["軽い", "IDE風"],
    recommendedLineHeight: 1.3,
  },
  {
    id: "biz-readable",
    label: "BIZ UDゴシック",
    value: "'BIZ UDGothic', 'Cascadia Mono', 'JetBrains Mono', 'MS Gothic', monospace",
    sample: "Aa 0123 日本語",
    description: "日本語重視。太めで表と説明文を追いやすい",
    tags: ["日本語", "表"],
    recommendedLineHeight: 1.4,
  },
  {
    id: "hg-gothic-m",
    label: "HGゴシックM",
    value: HG_GOTHIC_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "太め。教材やログの日本語が見やすい",
    tags: ["日本語", "太め"],
    recommendedLineHeight: 1.4,
  },
  {
    id: "ms-gothic",
    label: "MSゴシック",
    value: "'MS Gothic', 'BIZ UDGothic', monospace",
    sample: "Aa 0123 日本語",
    description: "等幅。日本語表の列が揃いやすい",
    tags: ["等幅", "表", "日本語"],
    recommendedLineHeight: 1.35,
  },
  {
    id: "mac-style",
    label: "Mac風 SF/ヒラギノ",
    value: MAC_STYLE_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "Mac風。細めで画面の印象がすっきりする",
    tags: ["Mac風", "印象変更"],
    recommendedLineHeight: 1.35,
  },
  {
    id: "ud-kyokasho",
    label: "UD 教科書体",
    value: "'UD Digi Kyokasho N-R', 'UD Digi Kyokasho N', 'BIZ UDGothic', 'MS Gothic', monospace",
    sample: "Aa 0123 日本語",
    description: "教科書体。説明文の雰囲気がやわらかくなる",
    tags: ["教材", "印象変更"],
    recommendedLineHeight: 1.5,
  },
  {
    id: "biz-udmincho",
    label: "BIZ UD明朝",
    value: BIZ_UDMINCHO_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "明朝。文章が落ち着いて見える",
    tags: ["明朝", "印象変更"],
    recommendedLineHeight: 1.45,
  },
];

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;

export type UiDensity = "compact" | "standard" | "relaxed";

// Chrome-wide density axis, independent from the color theme. "standard" must
// stay byte-identical to the historical static tokens in global.css — existing
// users see no change (guarded by tests/unit/uiDensity.test.ts).
export const UI_DENSITY_TOKENS: Record<
  UiDensity,
  { fontXs: string; fontSm: string; fontMd: string; lineHeightUi: string; spaceScale: number }
> = {
  compact: { fontXs: "11px", fontSm: "12px", fontMd: "13px", lineHeightUi: "1.25", spaceScale: 0.85 },
  standard: { fontXs: "11px", fontSm: "12px", fontMd: "13px", lineHeightUi: "normal", spaceScale: 1 },
  relaxed: { fontXs: "12px", fontSm: "13px", fontMd: "15px", lineHeightUi: "1.8", spaceScale: 1.25 },
};

export function normalizeUiDensity(value: unknown): UiDensity {
  return value === "compact" || value === "relaxed" ? value : "standard";
}

export interface ThemeSnapshot {
  themeId: string;
  themeTweaks: ThemeTweaks;
}

interface ThemeState {
  themeId: string;
  theme: ThemeDefinition;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  themeTweaks: ThemeTweaks;
  previousThemeSnapshot: ThemeSnapshot | null;
  uiDensity: UiDensity;

  setTheme: (id: string) => void;
  restoreThemeSnapshot: () => void;
  setUiDensity: (density: UiDensity) => void;
  setFontSize: (size: number) => void;
  adjustFontSize: (delta: number) => void;
  setFontFamily: (fontFamily: string) => void;
  setLineHeight: (lineHeight: number) => void;
  setThemeTweakEnabled: (enabled: boolean) => void;
  setThemeTweakColor: (key: ThemeTweakColorKey, color: string) => void;
  applyThemeTweakPreset: (colors: Partial<Record<ThemeTweakColorKey, string>>) => void;
  setThemeBackground: (background: Partial<ThemeBackgroundSettings>) => void;
  clearThemeTweakColor: (key: ThemeTweakColorKey) => void;
  resetThemeTweaks: () => void;
  hydrateSettings: (settings: { themeId?: string; fontSize?: number; fontFamily?: unknown; lineHeight?: unknown; themeTweaks?: unknown; uiDensity?: unknown }) => void;
}

const ALL_THEME_TWEAK_COLOR_KEYS = Array.from(
  new Set<ThemeTweakColorKey>(
    THEME_TWEAK_GROUPS.flatMap((group) => group.fields.map((field) => field.key)),
  ),
);

function resolveTheme(themeId: string, tweaks: ThemeTweaks): ThemeDefinition {
  return applyThemeTweaks(getTheme(themeId), tweaks);
}

function themeToTweakColors(theme: ThemeDefinition): Partial<Record<ThemeTweakColorKey, string>> {
  return Object.fromEntries(
    ALL_THEME_TWEAK_COLOR_KEYS.map((key) => [key, readThemeColor(theme, key)]),
  ) as Partial<Record<ThemeTweakColorKey, string>>;
}

function migrateLegacyThemeSettings(themeId: string | undefined, themeTweaksInput: unknown): ThemeTweaks {
  const resolvedThemeId = resolveThemeId(themeId ?? DEFAULT_THEME_ID);
  const themeTweaks = normalizeThemeTweaks(themeTweaksInput ?? DEFAULT_THEME_TWEAKS);

  if (resolvedThemeId === DEFAULT_THEME_ID) {
    return themeTweaks;
  }

  const legacyThemeColors = themeToTweakColors(getTheme(resolvedThemeId));
  return normalizeThemeTweaks({
    ...themeTweaks,
    enabled: true,
    colors: {
      ...legacyThemeColors,
      ...themeTweaks.colors,
    },
    background: themeTweaks.background,
  });
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

export function normalizeLineHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1.35;
  }
  const clamped = Math.max(1, Math.min(2, value));
  return Math.round(clamped * 100) / 100;
}

export function normalizeFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 14;
  }
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(value)));
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: DEFAULT_THEME_ID,
  theme: getTheme(DEFAULT_THEME_ID),
  fontSize: 14,
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  lineHeight: 1.35,
  themeTweaks: DEFAULT_THEME_TWEAKS,
  previousThemeSnapshot: null,
  uiDensity: "standard",

  setUiDensity: (density) => {
    set({ uiDensity: normalizeUiDensity(density) });
  },

  setTheme: (id) => {
    const nextThemeId = resolveThemeId(id);
    set((state) => {
      // Picking a theme is a clean switch: the chosen theme becomes the base
      // and the previous theme's per-key color tweaks are dropped. Background
      // tweaks (image / opacity) are preserved. The pre-switch state is kept
      // as a snapshot so the discard can be undone from the toast.
      const themeTweaks = normalizeThemeTweaks({
        ...state.themeTweaks,
        colors: {},
        background: state.themeTweaks.background,
      });
      return {
        themeId: nextThemeId,
        theme: resolveTheme(nextThemeId, themeTweaks),
        themeTweaks,
        previousThemeSnapshot: {
          themeId: state.themeId,
          themeTweaks: state.themeTweaks,
        },
      };
    });
  },

  restoreThemeSnapshot: () => {
    set((state) => {
      const snapshot = state.previousThemeSnapshot;
      if (!snapshot) {
        return state;
      }
      const themeTweaks = normalizeThemeTweaks(snapshot.themeTweaks);
      return {
        themeId: snapshot.themeId,
        theme: resolveTheme(snapshot.themeId, themeTweaks),
        themeTweaks,
        previousThemeSnapshot: null,
      };
    });
  },

  setFontSize: (fontSize) => {
    set({ fontSize: normalizeFontSize(fontSize) });
  },

  adjustFontSize: (delta) => {
    set((state) => {
      const fontSize = normalizeFontSize(state.fontSize + delta);
      return fontSize === state.fontSize ? state : { fontSize };
    });
  },

  setFontFamily: (fontFamily) => {
    set({ fontFamily: normalizeFontFamily(fontFamily) });
  },

  setLineHeight: (lineHeight) => {
    set({ lineHeight: normalizeLineHeight(lineHeight) });
  },

  setThemeTweakEnabled: (enabled) => {
    set((state) => {
      const themeTweaks = normalizeThemeTweaks({
        ...state.themeTweaks,
        enabled,
      });
      return {
        themeTweaks,
        theme: resolveTheme(state.themeId, themeTweaks),
      };
    });
  },

  setThemeTweakColor: (key, color) => {
    const normalizedColor = normalizeThemeColor(color);
    if (!normalizedColor) {
      return;
    }

    set((state) => {
      const themeTweaks = normalizeThemeTweaks({
        enabled: true,
        colors: {
          ...state.themeTweaks.colors,
          [key]: normalizedColor,
        },
        background: state.themeTweaks.background,
      });
      return {
        themeTweaks,
        theme: resolveTheme(state.themeId, themeTweaks),
      };
    });
  },

  applyThemeTweakPreset: (colors) => {
    set((state) => {
      const nextColors = { ...state.themeTweaks.colors };
      for (const key of THEME_TWEAK_PRESET_SCOPE) {
        delete nextColors[key];
      }
      const themeTweaks = normalizeThemeTweaks({
        enabled: true,
        colors: {
          ...nextColors,
          ...colors,
        },
        background: state.themeTweaks.background,
      });
      return {
        themeTweaks,
        theme: resolveTheme(state.themeId, themeTweaks),
      };
    });
  },

  setThemeBackground: (background) => {
    set((state) => {
      const themeTweaks = normalizeThemeTweaks({
        ...state.themeTweaks,
        background: {
          ...state.themeTweaks.background,
          ...background,
        },
      });
      return {
        themeTweaks,
        theme: resolveTheme(state.themeId, themeTweaks),
      };
    });
  },

  clearThemeTweakColor: (key) => {
    set((state) => {
      const colors = { ...state.themeTweaks.colors };
      delete colors[key];
      const themeTweaks = normalizeThemeTweaks({
        ...state.themeTweaks,
        colors,
      });
      return {
        themeTweaks,
        theme: resolveTheme(state.themeId, themeTweaks),
      };
    });
  },

  resetThemeTweaks: () => {
    set((state) => ({
      themeTweaks: DEFAULT_THEME_TWEAKS,
      theme: resolveTheme(state.themeId, DEFAULT_THEME_TWEAKS),
    }));
  },

  hydrateSettings: (settings) => {
    const nextThemeId = resolveThemeId(settings.themeId ?? DEFAULT_THEME_ID);
    const themeTweaks = migrateLegacyThemeSettings(settings.themeId, settings.themeTweaks);
    const nextFont = normalizeFontSize(settings.fontSize);
    const nextFontFamily = normalizeFontFamily(settings.fontFamily);
    const nextLineHeight = normalizeLineHeight(settings.lineHeight);
    set({
      themeId: nextThemeId,
      theme: resolveTheme(nextThemeId, themeTweaks),
      fontSize: nextFont,
      fontFamily: nextFontFamily,
      lineHeight: nextLineHeight,
      themeTweaks,
      uiDensity: normalizeUiDensity(settings.uiDensity),
    });
  },
}));
