import { create } from "zustand";
import type { ThemeDefinition } from "../types";
import { DEFAULT_THEME_ID, getTheme, resolveThemeId } from "../components/theme/themeDefinitions";

interface ThemeState {
  themeId: string;
  theme: ThemeDefinition;
  fontSize: number;

  setTheme: (id: string) => void;
  setFontSize: (size: number) => void;
  hydrateSettings: (settings: { themeId?: string; fontSize?: number }) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: DEFAULT_THEME_ID,
  theme: getTheme(DEFAULT_THEME_ID),
  fontSize: 14,

  setTheme: (id) => {
    const nextThemeId = resolveThemeId(id);
    const theme = getTheme(nextThemeId);
    set({ themeId: nextThemeId, theme });
  },

  setFontSize: (fontSize) => {
    set({ fontSize: Math.max(10, Math.min(24, fontSize)) });
  },

  hydrateSettings: (settings) => {
    const nextThemeId = resolveThemeId(settings.themeId ?? DEFAULT_THEME_ID);
    const nextTheme = getTheme(nextThemeId);
    const nextFont = typeof settings.fontSize === "number"
      ? Math.max(10, Math.min(24, settings.fontSize))
      : 14;
    set({
      themeId: nextThemeId,
      theme: nextTheme,
      fontSize: nextFont,
    });
  },
}));