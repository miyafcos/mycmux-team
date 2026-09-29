import { create } from "zustand";
import type { ThemeBackgroundSettings, ThemeDefinition, ThemeTweakColorKey, ThemeTweaks } from "../types";
import { DEFAULT_THEME_ID, getTheme, resolveThemeId } from "../components/theme/themeDefinitions";
import { stackBreaksBoxDrawing, stackFallsBackEntirely } from "../lib/fontAvailability";
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

// The first family ships with the app (see the @font-face block at the top of
// global.css), so this resolves to identical glyphs on Windows and macOS. It
// used to name JetBrains Mono first, which no stock macOS install carries:
// measured on the Mac on 2026-09-10, none of the families any preset named were
// present and every stack fell through to Menlo, whose 0.6em halfwidth advance
// does not divide the 1.0em fullwidth one and so misaligns Japanese tables and
// box drawing by roughly 3px per character.
export const DEFAULT_TERMINAL_FONT_FAMILY =
  "'UDEV Gothic NF', 'BIZ UDGothic', ui-monospace, 'MS Gothic', monospace";

const LEGACY_CASCADIA_FONT_FAMILY =
  "'Cascadia Mono', 'Cascadia Code', 'BIZ UDGothic', 'MS Gothic', monospace";
const LEGACY_CONSOLAS_FONT_FAMILY = "Consolas, 'BIZ UDGothic', 'MS Gothic', monospace";
const LEGACY_MEIRYO_FONT_FAMILY = "'Meiryo', 'Meiryo UI', 'BIZ UDGothic', 'Cascadia Mono', monospace";
const LEGACY_YU_GOTHIC_FONT_FAMILY = "'Yu Gothic UI', 'Yu Gothic', 'BIZ UDGothic', 'Cascadia Mono', monospace";
const HG_GOTHIC_FONT_FAMILY = "'HGｺﾞｼｯｸM', 'HGPｺﾞｼｯｸM', 'BIZ UDGothic', 'MS Gothic', monospace";
const BIZ_READABLE_FONT_FAMILY = "'BIZ UDGothic', 'Cascadia Mono', 'JetBrains Mono', 'MS Gothic', monospace";
const BIZ_UDMINCHO_FONT_FAMILY =
  "'BIZ UDMincho', 'BIZ UDPMincho', 'Yu Mincho', 'MS Mincho', 'BIZ UDGothic', monospace";
// Retained only so an old saved value still migrates. It names 'SF Mono', which
// is not a family CSS can resolve on macOS -- the system exposes that face
// through the `ui-monospace` generic instead -- so every stack below it was
// dead weight and the whole thing silently resolved to Menlo.
const LEGACY_MAC_STYLE_FONT_FAMILY =
  "'SF Mono', 'Menlo', 'Monaco', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'BIZ UDGothic', 'Yu Gothic UI', monospace";
// The macOS system faces, reached the way macOS actually exposes them.
const SYSTEM_MONO_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, 'Hiragino Sans', 'BIZ UDGothic', monospace";
const CASCADIA_BIZ_FONT_FAMILY =
  "'Cascadia Code', 'Cascadia Mono', 'BIZ UDGothic', 'Yu Gothic UI', 'MS Gothic', monospace";
const CONSOLAS_MEIRYO_FONT_FAMILY =
  "Consolas, 'Meiryo UI', Meiryo, 'BIZ UDGothic', 'MS Gothic', monospace";

export const TERMINAL_FONT_PRESETS: TerminalFontPreset[] = [
  {
    id: "jetbrains-ja",
    label: "UDEV Gothic (同梱)",
    value: DEFAULT_TERMINAL_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "標準。アプリに入っているので Windows と Mac で字面が揃う",
    tags: ["標準", "コード", "同梱"],
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
    id: "system-mono-ja",
    label: "macOS 標準 + ヒラギノ",
    value: SYSTEM_MONO_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "Mac 純正。英数字は美しいが、日本語の幅が半角2文字ぶんにならない",
    tags: ["macOS", "日本語"],
    recommendedLineHeight: 1.45,
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
    value: BIZ_READABLE_FONT_FAMILY,
    sample: "Aa 0123 日本語",
    description: "日本語重視。太めで表と説明文を追いやすい",
    tags: ["日本語", "表"],
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
export const UI_FONT_SCALE_DEFAULT = 1;
export const UI_FONT_SCALE_MIN = 0.9;
export const UI_FONT_SCALE_MAX = 1.5;
export const UI_FONT_SCALE_STEP = 0.05;

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

export function normalizeUiFontScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return UI_FONT_SCALE_DEFAULT;
  const clamped = Math.max(UI_FONT_SCALE_MIN, Math.min(UI_FONT_SCALE_MAX, value));
  return Number((Math.round(clamped / UI_FONT_SCALE_STEP) * UI_FONT_SCALE_STEP).toFixed(2));
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
  uiFontScale: number;
  /**
   * The stack hydration replaced because this machine can resolve none of it,
   * or null. Hydration runs before the autosave subscription is attached, so a
   * repair made there would live only in memory and be redone on every launch;
   * the owner of persistence reads this, saves once, and clears it.
   */
  fontFamilyRepairedFrom: string | null;

  setTheme: (id: string) => void;
  restoreThemeSnapshot: () => void;
  setUiDensity: (density: UiDensity) => void;
  setUiFontScale: (scale: number) => void;
  applyQuickSize: (size: "small" | "medium" | "large") => void;
  setFontSize: (size: number) => void;
  adjustFontSize: (delta: number) => void;
  setFontFamily: (fontFamily: string) => void;
  clearFontFamilyRepair: () => void;
  setLineHeight: (lineHeight: number) => void;
  setThemeTweakEnabled: (enabled: boolean) => void;
  setThemeTweakColor: (key: ThemeTweakColorKey, color: string) => void;
  applyThemeTweakPreset: (colors: Partial<Record<ThemeTweakColorKey, string>>) => void;
  setThemeBackground: (background: Partial<ThemeBackgroundSettings>) => void;
  clearThemeTweakColor: (key: ThemeTweakColorKey) => void;
  resetThemeTweaks: () => void;
  hydrateSettings: (settings: { themeId?: string; fontSize?: number; fontFamily?: unknown; lineHeight?: unknown; themeTweaks?: unknown; uiDensity?: unknown; uiFontScale?: unknown }) => void;
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
    return BIZ_READABLE_FONT_FAMILY;
  }
  if (trimmed === LEGACY_CONSOLAS_FONT_FAMILY) {
    return BIZ_UDMINCHO_FONT_FAMILY;
  }
  if (trimmed === LEGACY_MAC_STYLE_FONT_FAMILY) {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  if (trimmed === HG_GOTHIC_FONT_FAMILY) {
    return BIZ_READABLE_FONT_FAMILY;
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
  fontFamilyRepairedFrom: null,
  lineHeight: 1.35,
  themeTweaks: DEFAULT_THEME_TWEAKS,
  previousThemeSnapshot: null,
  uiDensity: "standard",
  uiFontScale: UI_FONT_SCALE_DEFAULT,

  setUiDensity: (density) => {
    set({ uiDensity: normalizeUiDensity(density) });
  },

  setUiFontScale: (scale) => {
    set({ uiFontScale: normalizeUiFontScale(scale) });
  },

  applyQuickSize: (size) => {
    const next =
      size === "small"
        ? { fontSize: 12, uiFontScale: 0.95, uiDensity: "compact" as const }
        : size === "large"
          ? { fontSize: 16, uiFontScale: 1.15, uiDensity: "relaxed" as const }
          : { fontSize: 14, uiFontScale: 1, uiDensity: "standard" as const };
    set((state) => (
      state.fontSize === next.fontSize
      && state.uiFontScale === next.uiFontScale
      && state.uiDensity === next.uiDensity
        ? state
        : next
    ));
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
    set({ fontFamily: normalizeFontFamily(fontFamily), fontFamilyRepairedFrom: null });
  },

  clearFontFamilyRepair: () => {
    set({ fontFamilyRepairedFrom: null });
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
    const savedFontFamily = normalizeFontFamily(settings.fontFamily);
    // Two ways a saved stack stops working as a terminal font, both of which the
    // Mac hit with `'MS Gothic', 'BIZ UDGothic', monospace` carried over from the
    // Windows box. MS Gothic is not installed there at all. BIZ UDGothic is --
    // a real monospace face with correct 0.5em/1.0em proportions, which is why
    // nothing flagged it -- but it draws box-drawing glyphs at full width, and
    // the terminal lays them out as one cell, so every table, tree and progress
    // bar came apart. Falling back to the bundled face is visible and
    // correctable; rendering a setting nobody chose is neither.
    const absent = stackFallsBackEntirely(savedFontFamily);
    const rulesBroken = stackBreaksBoxDrawing(savedFontFamily);
    const savedStackIsUnusable = absent || rulesBroken;
    const nextFontFamily = savedStackIsUnusable
      ? DEFAULT_TERMINAL_FONT_FAMILY
      : savedFontFamily;
    const nextLineHeight = normalizeLineHeight(settings.lineHeight);
    set({
      themeId: nextThemeId,
      theme: resolveTheme(nextThemeId, themeTweaks),
      fontSize: nextFont,
      fontFamily: nextFontFamily,
      lineHeight: nextLineHeight,
      themeTweaks,
      uiDensity: normalizeUiDensity(settings.uiDensity),
      uiFontScale: normalizeUiFontScale(settings.uiFontScale),
      fontFamilyRepairedFrom: nextFontFamily === savedFontFamily ? null : savedFontFamily,
    });
  },
}));
