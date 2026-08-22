/**
 * The one answer to "is the app compositing as glass right now?".
 *
 * Three things decide it — the chosen background, whether that wallpaper is
 * actually on disk, and whether the user asked to fill surfaces with the theme
 * colour — and every surface has to agree. AppShell already reads all three to
 * build its CSS variables, so it computes the boolean once and publishes it
 * here; everyone else (terminals in particular) subscribes to the primitive.
 *
 * Keeping it a single boolean is the point. Terminals used to subscribe to the
 * whole wallpaper cache object, which meant every one-percent tick of a
 * download re-rendered every mounted XTerm. A boolean changes twice per
 * download at most.
 */

import { useLayoutEffect } from "react";
import { create } from "zustand";

import { resolveEffectiveMediaActive, type WallpaperCache } from "../lib/wallpaperCache";
import { useThemeStore } from "./themeStore";
import type { ThemeBackgroundSettings } from "../types";

interface CompositionState {
  /** True when chrome and terminals should paint as glass over a wallpaper. */
  mediaActive: boolean;
}

/**
 * Defaults to false — opaque. A surface that mounts before AppShell has
 * published (or outside it entirely) paints solid, which is the safe miss:
 * readable, just not translucent, and corrected on the next publish.
 */
export const useCompositionStore = create<CompositionState>(() => ({
  mediaActive: false,
}));

/** Writes the boolean, skipping the notify when nothing moved. */
export function setEffectiveMediaActive(value: boolean): void {
  if (useCompositionStore.getState().mediaActive !== value) {
    useCompositionStore.setState({ mediaActive: value });
  }
}

/**
 * Computes the effective glass state and publishes it. The imperative twin of
 * `useEffectiveMediaActive`, for code that is not in a render tree.
 */
export function publishEffectiveMediaActive(
  background: ThemeBackgroundSettings,
  cache: WallpaperCache,
): boolean {
  const next = resolveEffectiveMediaActive(background, cache);
  setEffectiveMediaActive(next);
  return next;
}

/**
 * The publisher AppShell mounts: one computation per render, one store write
 * per actual change, and the value handed back for AppShell's own CSS.
 *
 * The write is a layout effect rather than a render-time side effect so React
 * never sees a store update issued while a different component is rendering.
 * Terminals created during that one-frame gap re-read the store just before
 * `new Terminal()` (see `readLiveTerminalAppearance`), so nothing is stranded.
 */
export function useEffectiveMediaActive(
  background: ThemeBackgroundSettings,
  cache: WallpaperCache,
): boolean {
  const mediaActive = resolveEffectiveMediaActive(background, cache);
  useLayoutEffect(() => {
    setEffectiveMediaActive(mediaActive);
  }, [mediaActive]);
  return mediaActive;
}

/** Non-reactive read, for callbacks and async work outside the render tree. */
export function getEffectiveMediaActive(): boolean {
  return useCompositionStore.getState().mediaActive;
}

// xterm's minimumContrastRatio only works against an opaque, known background.
// With a media background the terminal background is transparent (the wallpaper
// is composited in CSS), so it must be disabled — otherwise xterm corrects the
// foreground against a phantom black background and washes out dark text.
export const TERMINAL_MIN_CONTRAST_DARK = 7;
export const TERMINAL_MIN_CONTRAST_LIGHT = 4.5;
export const TERMINAL_MIN_CONTRAST_GLASS = 1;

/**
 * The contrast policy, in one place. Live theme updates, cached reattach and
 * cold init all call this, so a terminal cannot end up on a different rule
 * than its neighbour.
 */
export function resolveMinimumContrastRatio(input: {
  mediaActive: boolean;
  isLight: boolean;
}): number {
  if (input.mediaActive) {
    return TERMINAL_MIN_CONTRAST_GLASS;
  }
  return input.isLight ? TERMINAL_MIN_CONTRAST_LIGHT : TERMINAL_MIN_CONTRAST_DARK;
}

export interface TerminalAppearance {
  mediaActive: boolean;
  /** What xterm should paint its own background with: 1 unless it is glass. */
  terminalOpacity: number;
  minimumContrastRatio: number;
  isLight: boolean;
}

export function resolveTerminalAppearance(input: {
  mediaActive: boolean;
  isLight: boolean;
  terminalOpacity: number;
}): TerminalAppearance {
  return {
    mediaActive: input.mediaActive,
    terminalOpacity: input.mediaActive ? input.terminalOpacity : 1,
    minimumContrastRatio: resolveMinimumContrastRatio(input),
    isLight: input.isLight,
  };
}

/**
 * Resolves the appearance from the live stores rather than from a closure.
 *
 * Cold init awaits IPC before it constructs the Terminal; a wallpaper that
 * finished downloading, a theme switch, or a solid/glass toggle in that window
 * would otherwise be baked out of the new terminal until the next settings
 * change. Calling this immediately before `new Terminal()` closes that gap.
 */
export function readLiveTerminalAppearance(): TerminalAppearance {
  const themeState = useThemeStore.getState();
  return resolveTerminalAppearance({
    mediaActive: getEffectiveMediaActive(),
    isLight: themeState.theme.colorScheme === "light",
    terminalOpacity: themeState.themeTweaks.background.terminalOpacity,
  });
}
