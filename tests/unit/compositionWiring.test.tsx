// @vitest-environment jsdom

// The glass/solid answer has exactly one producer and many consumers, and the
// bug this guards against is subtle: when a consumer re-derives the answer from
// the wallpaper cache instead of reading the published boolean, everything
// still looks right in a screenshot. It only shows up as a terminal that stays
// opaque over a wallpaper, or as every mounted terminal re-rendering a hundred
// times while one file downloads.
//
// So these render the real wiring — AppShell's publisher hook and the terminal's
// selector — rather than calling the pure helpers.

import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_WALLPAPER_CACHE,
  applyCacheState,
  applyDownloadStarted,
  applyProgress,
  type WallpaperCache,
} from "../../src/lib/wallpaperCache";
import { DEFAULT_THEME_BACKGROUND } from "../../src/lib/themeBackgrounds";
import {
  readLiveTerminalAppearance,
  useCompositionStore,
  useEffectiveMediaActive,
} from "../../src/stores/compositionStore";
import { useThemeStore } from "../../src/stores/themeStore";
import type { ThemeBackgroundSettings } from "../../src/types";

const PRESET_ID = "catppuccin_black_hole";

const OFFLINE_CACHE: WallpaperCache = {
  ...EMPTY_WALLPAPER_CACHE,
  status: "ready",
  directory: "C:/Users/someone/.mycmux/wallpapers",
};

const DOWNLOADED_CACHE = applyCacheState(OFFLINE_CACHE, {
  directory: OFFLINE_CACHE.directory,
  entries: [{ id: PRESET_ID, path: `C:/Users/someone/.mycmux/wallpapers/${PRESET_ID}.webp`, bytes: 1024 }],
  totalBytes: 1024,
});

const GLASS_BACKGROUND: ThemeBackgroundSettings = {
  ...DEFAULT_THEME_BACKGROUND,
  mode: "preset",
  presetId: PRESET_ID,
  terminalOpacity: 0.45,
};

const SOLID_BACKGROUND: ThemeBackgroundSettings = { ...GLASS_BACKGROUND, solidSurfaces: true };

/** What AppShell computed on its last render. */
let publishedByAppShell: boolean | null = null;
/** What a terminal saw, and how many times it was asked to re-render. */
let terminalReads: boolean[] = [];

function AppShellStandIn({
  background,
  cache,
}: {
  background: ThemeBackgroundSettings;
  cache: WallpaperCache;
}) {
  publishedByAppShell = useEffectiveMediaActive(background, cache);
  return null;
}

// memo, like the real XTermWrapper: a parent re-render must not be enough to
// re-render it, so what is counted here is genuinely the store subscription.
const TerminalStandIn = memo(function TerminalStandIn() {
  const mediaActive = useCompositionStore((s) => s.mediaActive);
  terminalReads.push(mediaActive);
  return null;
});

describe("AppShell publishes the glass answer and terminals read it", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useCompositionStore.setState({ mediaActive: false });
    publishedByAppShell = null;
    terminalReads = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function render(background: ThemeBackgroundSettings, cache: WallpaperCache): void {
    act(() => {
      root.render(
        <>
          <AppShellStandIn background={background} cache={cache} />
          <TerminalStandIn />
        </>,
      );
    });
  }

  function lastTerminalRead(): boolean {
    return terminalReads[terminalReads.length - 1] as boolean;
  }

  it("agrees at every step of undownloaded -> downloaded -> solid on -> solid off", () => {
    render(GLASS_BACKGROUND, OFFLINE_CACHE);
    expect(publishedByAppShell).toBe(false);
    expect(lastTerminalRead()).toBe(false);

    render(GLASS_BACKGROUND, DOWNLOADED_CACHE);
    expect(publishedByAppShell).toBe(true);
    expect(lastTerminalRead()).toBe(true);

    render(SOLID_BACKGROUND, DOWNLOADED_CACHE);
    expect(publishedByAppShell).toBe(false);
    expect(lastTerminalRead()).toBe(false);

    render(GLASS_BACKGROUND, DOWNLOADED_CACHE);
    expect(publishedByAppShell).toBe(true);
    expect(lastTerminalRead()).toBe(true);
  });

  it("does not re-render the terminal while a download only ticks its percentage", () => {
    let cache = applyDownloadStarted(OFFLINE_CACHE, PRESET_ID);
    render(GLASS_BACKGROUND, cache);
    const rendersBefore = terminalReads.length;

    for (let percent = 10; percent <= 100; percent += 10) {
      cache = applyProgress(cache, {
        id: PRESET_ID,
        receivedBytes: percent,
        totalBytes: 100,
        percent,
      });
      // AppShell re-renders on every cache object change; the terminal must not.
      render(GLASS_BACKGROUND, cache);
    }

    expect(terminalReads.length).toBe(rendersBefore);
    expect(publishedByAppShell).toBe(false);
  });
});

describe("a terminal created after an await sees the current answer", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useCompositionStore.setState({ mediaActive: false });
    useThemeStore.getState().hydrateSettings({ themeId: "mayonaka", themeTweaks: undefined });
    useThemeStore.getState().setThemeBackground({ terminalOpacity: 0.45 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Cold init awaits IPC between mount and `new Terminal()`. Whatever the
  // effect closed over at mount is stale by then if anything moved.
  it("re-resolves theme and contrast at construction time, not at mount time", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    let atMount: ReturnType<typeof readLiveTerminalAppearance> | null = null;
    let atConstruction: ReturnType<typeof readLiveTerminalAppearance> | null = null;
    let release: (() => void) | null = null;
    const ipc = new Promise<void>((resolve) => {
      release = resolve;
    });

    function ColdInitStandIn() {
      atMount = readLiveTerminalAppearance();
      void ipc.then(() => {
        atConstruction = readLiveTerminalAppearance();
      });
      return null;
    }

    act(() => root.render(<ColdInitStandIn />));
    expect(atMount).toMatchObject({ mediaActive: false, minimumContrastRatio: 7, terminalOpacity: 1 });

    // The wallpaper lands (or the user unticks "fill with theme colour") while
    // the session-alive probe is still in flight.
    act(() => {
      useCompositionStore.setState({ mediaActive: true });
    });
    await act(async () => {
      release?.();
      await ipc;
    });

    expect(atConstruction).toMatchObject({
      mediaActive: true,
      minimumContrastRatio: 1,
      terminalOpacity: 0.45,
    });

    act(() => root.unmount());
    host.remove();
  });
});
