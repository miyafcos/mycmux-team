# Theme System

Updated 2026-08-11 (theme picker restoration). Source of truth:
`src/components/theme/themeDefinitions.ts`.

## ThemeDefinition Structure

```typescript
interface ThemeDefinition {
  id: string;
  name: string;            // Japanese display name (真夜中, 極夜, ...)
  group: ThemeGroup;       // "calm-dark" | "vivid-dark" | "light"
  description: string;
  colorScheme: "dark" | "light";
  terminal: TerminalColors; // 20 fields: bg/fg/cursor/selection + 16 ANSI
  chrome: {
    background: string;
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    textDim: string;
    accent: string;
    hover: string;
    selected: string;
    danger: string;
  };
  status: { working; waiting; done; error };
  notification: string;
}
```

Themes are authored as `ThemeDraft`s (a subset) and completed by
`completeTheme()`, which:

- derives `colorScheme` from the group,
- **clamps `textMuted`/`textDim` to a WCAG AA 4.5:1 floor** against
  `chrome.background` (`applyContrastFloor` / `resolveDimColor` in
  `colorContrast.ts`),
- fills `hover`/`selected`/`danger`/`status`/`notification` defaults per scheme.

## Bundled Themes (30)

30 themes in three groups: 静かな暗色 (calm-dark), 個性の強い暗色
(vivid-dark), 明るい配色 (light, 9 themes). Default: `mayonaka` (真夜中).
Legacy ids (e.g. `yoru-cafe`, `midnight`-era names) are mapped by
`THEME_ALIASES` in `resolveThemeId()`.

`RECOMMENDED_THEMES` is a curated shortlist (6 entries, both schemes) shown
first in the picker; entries carry a use-case reason and are guarded by
`tests/unit/themeRecommendations.test.ts` (existence, dark+light coverage,
AA-safe accent text).

## Picker UI

`src/components/theme/ThemePicker.tsx`, mounted directly inside the quick
settings section at the top of `AppearanceTab` (the advanced disclosure below
it hosts `ThemeTweakPanel` without a topSlot). Recommended cards are
always visible; the full 30-theme list expands per group. It is a
`radiogroup` with roving focus (arrow keys / Home / End).

Selection flow:

```
ThemePicker.onSelect(theme)
  → themeStore.setTheme(id)      // clean switch: color tweaks dropped,
                                 // background tweaks kept; previous
                                 // themeId+tweaks saved as a snapshot
  → toast (only when tweaks were discarded) with an undo action
  → restoreThemeSnapshot()       // undo: full round-trip
```

Do not remove the picker wiring: the original regression (30 themes defined,
`setTheme()` with zero callers after `ThemeSwitcher.tsx` was deleted) is
guarded by `tests/unit/themeRecommendations.test.ts`.

## Runtime Application

`AppShell.tsx` builds `themeVars` (the single conversion point) and spreads it
on the root element: chrome colors, derived tokens (`--cmux-accent-text`,
`--cmux-yellow`, shadows, on-colors), density tokens, and `colorScheme`.
`XTermWrapper` consumes `theme.terminal` via `resolveTerminalTheme()`
(`terminalThemeColors.ts`), which pre-applies an ANSI contrast floor when a
wallpaper background disables xterm's own `minimumContrastRatio` guard.

Persistence: `settings.theme_id` + `settings.theme_tweaks` in `data.json`
(save + two hydrate sites in `SocketListener.tsx` — main window and child
window; update BOTH when adding fields).

## Fine-tuning vs. Themes

`ThemeTweakPanel` ("選んだテーマの微調整") overlays per-key color tweaks on the
selected theme (`applyThemeTweaks`). The dark/light preset toggle applies a
tweak preset — it does not change `themeId`. `setTheme` is the only clean
switch.

## Out of Scope (decided 2026-08-11)

`BrowserPane`'s injected editor CSS stays light-fixed on purpose: it renders a
document-editing surface (white paper on a desk, Word-like). Making it follow
dark themes would produce "black paper", which is a worse defect. Do not
theme it.

## Contrast Contracts

- Every bundled light theme keeps terminal foreground at 7:1 against the
  terminal background. Its non-black ANSI colors and cursor meet 4.5:1.
- Light-theme status colors meet 4.5:1 against both `chrome.background` and
  `chrome.surface`; borders meet 1.6:1, accents meet 3:1, and the two chrome
  surfaces remain at least 1.15:1 apart.
- `tests/unit/themeContrast.test.ts` — WCAG floors across all 30 themes
  (text/muted/dim/accent-text vs chrome bg; terminal fg/bg ≥ 7; on-colors;
  ANSI ratchet).
- `tests/unit/tokenContract.test.ts` — every `var(--cmux-*)` reference must
  be defined in `global.css` `:root`; `themeVars` keys ⊆ `:root` keys.
