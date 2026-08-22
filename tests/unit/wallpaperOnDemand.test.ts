// Wallpapers are downloaded on demand (docs/design/wallpaper-on-demand.md).
//
// Two things about that are worth pinning, because both fail silently if they
// regress. The first is that a machine with no network still gets a usable
// picker: the thumbnails are bundled, so every card has an image and the ones
// that are not downloaded say so with the grey arrow. The second is that an
// install which chose a wallpaper before this change keeps that choice — the
// stored settings are not rewritten to something paintable, they just render
// as solid until the fetch lands.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME_BACKGROUND,
  THEME_BACKGROUND_PRESETS,
  normalizeThemeBackground,
} from "../../src/lib/themeBackgrounds";
import {
  EMPTY_WALLPAPER_CACHE,
  applyCacheState,
  applyDownloadFailed,
  applyDownloadFinished,
  applyDownloadStarted,
  applyProgress,
  cachedWallpaperPath,
  formatCacheSize,
  isWallpaperPaintable,
  resolveEffectiveMediaActive,
  wallpaperCardState,
} from "../../src/lib/wallpaperCache";
import {
  publishEffectiveMediaActive,
  useCompositionStore,
} from "../../src/stores/compositionStore";
import type { WallpaperCache } from "../../src/lib/wallpaperCache";
import type { ThemeBackgroundSettings } from "../../src/types";

/** What an install that picked a wallpaper on an older build has stored. */
const STORED_WALLPAPER_CHOICE: Record<string, unknown> = {
  mode: "preset",
  presetId: "catppuccin_black_hole",
  imagePath: "",
  imageOpacity: 0.9,
  imageBlur: 4,
  wallpaperTone: -0.3,
  panelOpacity: 0.5,
  terminalOpacity: 0.45,
};

/** A cache that has finished loading and holds nothing — the offline case. */
const OFFLINE_CACHE: WallpaperCache = {
  ...EMPTY_WALLPAPER_CACHE,
  status: "ready",
  directory: "C:/Users/someone/.mycmux/wallpapers",
};

function cacheWith(id: string, path: string): WallpaperCache {
  return applyCacheState(OFFLINE_CACHE, {
    directory: OFFLINE_CACHE.directory,
    entries: [{ id, path, bytes: 1024 }],
    totalBytes: 1024,
  });
}

describe("the picker works with nothing downloaded", () => {
  it("bundles a thumbnail for every preset, so the grid is never blank offline", () => {
    expect(THEME_BACKGROUND_PRESETS).toHaveLength(59);
    for (const preset of THEME_BACKGROUND_PRESETS) {
      expect(preset.thumbnailUrl, `${preset.id} has no thumbnail`).toBeTruthy();
    }
  });

  it("marks every preset as not downloaded when the cache is empty", () => {
    for (const preset of THEME_BACKGROUND_PRESETS) {
      expect(wallpaperCardState(preset.id, OFFLINE_CACHE)).toBe("notDownloaded");
    }
  });

  it("ships solid, so a fresh install downloads nothing at all", () => {
    expect(DEFAULT_THEME_BACKGROUND.mode).toBe("solid");
    expect(isWallpaperPaintable(DEFAULT_THEME_BACKGROUND, OFFLINE_CACHE)).toBe(false);
  });

  it("only calls a wallpaper downloaded once its file is in the cache", () => {
    const cache = cacheWith("koi", "C:/Users/someone/.mycmux/wallpapers/koi.webp");
    expect(wallpaperCardState("koi", cache)).toBe("downloaded");
    expect(wallpaperCardState("jellyfish", cache)).toBe("notDownloaded");
  });
});

describe("a stored wallpaper choice survives the move to on-demand", () => {
  it("does not rewrite the stored settings when the wallpaper is missing", () => {
    const normalized = normalizeThemeBackground(STORED_WALLPAPER_CHOICE);
    expect(normalized).toEqual({
      mode: "preset",
      presetId: "catppuccin_black_hole",
      imagePath: "",
      imageOpacity: 0.9,
      imageBlur: 4,
      wallpaperTone: -0.3,
      panelOpacity: 0.5,
      terminalOpacity: 0.45,
      solidSurfaces: false,
    });
  });

  it("falls back to solid on screen while the wallpaper is not there", () => {
    const background = normalizeThemeBackground(STORED_WALLPAPER_CHOICE) as ThemeBackgroundSettings;
    expect(isWallpaperPaintable(background, OFFLINE_CACHE)).toBe(false);
    expect(cachedWallpaperPath(background.presetId, OFFLINE_CACHE)).toBe("");
    // The setting itself is untouched: the choice is still theirs.
    expect(background.mode).toBe("preset");
    expect(background.presetId).toBe("catppuccin_black_hole");
  });

  it("paints the wallpaper again the moment the download lands", () => {
    const background = normalizeThemeBackground(STORED_WALLPAPER_CHOICE) as ThemeBackgroundSettings;
    const path = "C:/Users/someone/.mycmux/wallpapers/catppuccin_black_hole.webp";
    const cache = applyDownloadFinished(OFFLINE_CACHE, {
      id: "catppuccin_black_hole",
      path,
      bytes: 4096,
    });
    expect(isWallpaperPaintable(background, cache)).toBe(true);
    expect(cachedWallpaperPath(background.presetId, cache)).toBe(path);
  });

  it("keeps a user-chosen image file working, since it was never bundled", () => {
    const background: ThemeBackgroundSettings = {
      ...DEFAULT_THEME_BACKGROUND,
      mode: "image",
      imagePath: "C:/pictures/mine.png",
    };
    expect(isWallpaperPaintable(background, OFFLINE_CACHE)).toBe(true);
  });
});

describe("download state is always legible", () => {
  it("shows progress instead of a stale success while re-downloading", () => {
    const path = "C:/Users/someone/.mycmux/wallpapers/koi.webp";
    let cache = cacheWith("koi", path);
    cache = applyDownloadStarted(cache, "koi");
    expect(wallpaperCardState("koi", cache)).toBe("downloading");
    cache = applyProgress(cache, { id: "koi", receivedBytes: 50, totalBytes: 100, percent: 50 });
    expect(cache.progress.koi).toBe(50);
  });

  it("ignores progress for a wallpaper that is not being downloaded", () => {
    const cache = applyProgress(OFFLINE_CACHE, {
      id: "koi",
      receivedBytes: 100,
      totalBytes: 100,
      percent: 100,
    });
    expect(cache).toBe(OFFLINE_CACHE);
    expect(wallpaperCardState("koi", cache)).toBe("notDownloaded");
  });

  it("remembers a failure with its reason rather than looking untouched", () => {
    let cache = applyDownloadStarted(OFFLINE_CACHE, "koi");
    cache = applyDownloadFailed(cache, "koi", "Could not reach the wallpaper pack");
    expect(wallpaperCardState("koi", cache)).toBe("failed");
    expect(cache.errors.koi).toContain("Could not reach");
    expect(cache.progress.koi).toBeUndefined();
  });

  it("never leaves a failure without a message to show", () => {
    const cache = applyDownloadFailed(applyDownloadStarted(OFFLINE_CACHE, "koi"), "koi", "");
    expect(cache.errors.koi).toBeTruthy();
  });

  it("clears the old failure when the download is retried", () => {
    let cache = applyDownloadFailed(applyDownloadStarted(OFFLINE_CACHE, "koi"), "koi", "offline");
    cache = applyDownloadStarted(cache, "koi");
    expect(cache.errors.koi).toBeUndefined();
    expect(wallpaperCardState("koi", cache)).toBe("downloading");
  });

  it("counts a finished download once, however often it is re-fetched", () => {
    const wallpaper = { id: "koi", path: "C:/cache/koi.webp", bytes: 4096 };
    const once = applyDownloadFinished(OFFLINE_CACHE, wallpaper);
    const twice = applyDownloadFinished(once, wallpaper);
    expect(once.totalBytes).toBe(4096);
    expect(twice.totalBytes).toBe(4096);
  });

  it("reports the cache size in units a person reads", () => {
    expect(formatCacheSize(0)).toBe("0 MB");
    expect(formatCacheSize(4096)).toBe("4 KB");
    expect(formatCacheSize(12 * 1024 * 1024)).toBe("12.0 MB");
  });
});

// The glass answer travels one way: AppShell computes it from the background
// and the cache, publishes it, and terminals read the published boolean. These
// walk the whole path — undownloaded, downloaded, solid on, solid off — and
// assert the two ends never disagree. The React wiring of the same path is in
// compositionWiring.test.tsx.
describe("the painted-media answer is published once and read everywhere", () => {
  const presetOnDisk: ThemeBackgroundSettings = {
    ...DEFAULT_THEME_BACKGROUND,
    mode: "preset",
    presetId: "catppuccin_black_hole",
  };
  const cached = cacheWith(
    "catppuccin_black_hole",
    "C:/Users/someone/.mycmux/wallpapers/catppuccin_black_hole.webp",
  );

  /** What a terminal sees: the store, never the cache. */
  const readAsTerminal = () => useCompositionStore.getState().mediaActive;

  beforeEach(() => {
    useCompositionStore.setState({ mediaActive: false });
  });

  it("treats an undownloaded preset as opaque on both ends", () => {
    expect(isWallpaperPaintable(presetOnDisk, OFFLINE_CACHE)).toBe(false);
    expect(publishEffectiveMediaActive(presetOnDisk, OFFLINE_CACHE)).toBe(false);
    expect(readAsTerminal()).toBe(false);
  });

  it("turns glass on for both ends only after the wallpaper file is in the cache", () => {
    expect(isWallpaperPaintable(presetOnDisk, cached)).toBe(true);
    expect(publishEffectiveMediaActive(presetOnDisk, cached)).toBe(true);
    expect(readAsTerminal()).toBe(true);
  });

  it("keeps both ends opaque when solidSurfaces is on, even with a cached wallpaper", () => {
    const solid = { ...presetOnDisk, solidSurfaces: true };
    expect(isWallpaperPaintable(solid, cached)).toBe(true);
    expect(publishEffectiveMediaActive(solid, cached)).toBe(false);
    expect(readAsTerminal()).toBe(false);
  });

  it("agrees at every step of undownloaded -> downloaded -> solid on -> solid off", () => {
    const solid = { ...presetOnDisk, solidSurfaces: true };
    const steps: Array<[ThemeBackgroundSettings, WallpaperCache, boolean]> = [
      [presetOnDisk, OFFLINE_CACHE, false],
      [presetOnDisk, cached, true],
      [solid, cached, false],
      [presetOnDisk, cached, true],
    ];
    for (const [background, cache, expected] of steps) {
      const fromAppShell = publishEffectiveMediaActive(background, cache);
      expect(fromAppShell).toBe(expected);
      expect(resolveEffectiveMediaActive(background, cache)).toBe(expected);
      expect(readAsTerminal()).toBe(fromAppShell);
    }
  });

  it("does not notify subscribers while only the download percentage moves", () => {
    let downloading = applyDownloadStarted(OFFLINE_CACHE, "catppuccin_black_hole");
    publishEffectiveMediaActive(presetOnDisk, downloading);
    const notified = vi.fn();
    const unsubscribe = useCompositionStore.subscribe(notified);

    for (let percent = 10; percent <= 100; percent += 10) {
      downloading = applyProgress(downloading, {
        id: "catppuccin_black_hole",
        receivedBytes: percent,
        totalBytes: 100,
        percent,
      });
      publishEffectiveMediaActive(presetOnDisk, downloading);
    }

    expect(notified).not.toHaveBeenCalled();
    expect(readAsTerminal()).toBe(false);

    publishEffectiveMediaActive(presetOnDisk, cached);
    expect(notified).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
