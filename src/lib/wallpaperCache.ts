/**
 * Client side of on-demand wallpapers.
 *
 * The picker always has something to draw — the thumbnails are bundled — but
 * the wallpaper itself only exists once it has been downloaded into the
 * runtime directory. This module is the one place that knows which ones are
 * there, which are being fetched, and which failed, so the settings panel and
 * the background layer agree without either owning the state.
 *
 * The reducers below are pure and hold the rules worth pinning: a wallpaper
 * that is not cached reads as "not downloaded" rather than as an error, a
 * download in progress never looks finished, and a failure is remembered until
 * it is retried instead of disappearing.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import type { ThemeBackgroundSettings } from "../types";
import { isMediaBackgroundActive } from "./theme/resolveTheme";

export interface WallpaperCache {
  /** "idle" until the first read of the cache directory has come back. */
  status: "idle" | "loading" | "ready";
  directory: string;
  /** id -> absolute path of the downloaded file. */
  paths: Record<string, string>;
  totalBytes: number;
  /** id -> 0..100 while a download is running. */
  progress: Record<string, number>;
  /** id -> why the last attempt failed. Cleared when it is retried. */
  errors: Record<string, string>;
}

export type WallpaperCardState = "downloaded" | "downloading" | "failed" | "notDownloaded";

interface CachedWallpaper {
  id: string;
  path: string;
  bytes: number;
}

interface WallpaperCacheStateDto {
  directory: string;
  entries: CachedWallpaper[];
  totalBytes: number;
}

interface DownloadProgressEvent {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
}

export const EMPTY_WALLPAPER_CACHE: WallpaperCache = {
  status: "idle",
  directory: "",
  paths: {},
  totalBytes: 0,
  progress: {},
  errors: {},
};

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

export function isWallpaperDownloaded(id: string, cache: WallpaperCache): boolean {
  return Boolean(cache.paths[id]);
}

/**
 * A download in progress outranks a stale success so a re-download cannot
 * flash as finished, and an error outranks "not downloaded" so a failure is
 * never quietly indistinguishable from never having tried.
 */
export function wallpaperCardState(id: string, cache: WallpaperCache): WallpaperCardState {
  if (typeof cache.progress[id] === "number") {
    return "downloading";
  }
  if (cache.errors[id]) {
    return "failed";
  }
  return cache.paths[id] ? "downloaded" : "notDownloaded";
}

/** The cached file for a wallpaper, or "" when there is nothing to paint yet. */
export function cachedWallpaperPath(id: string, cache: WallpaperCache): string {
  return cache.paths[id] ?? "";
}

/**
 * Whether the selected background can actually be painted right now.
 *
 * `isMediaBackgroundActive` answers what the *settings* ask for; this adds the
 * one thing the settings cannot know, which is whether the file is on disk. An
 * install that chose a wallpaper before it became a download still has that
 * choice stored — it just paints as solid until the fetch lands, and the
 * stored setting is never rewritten to say otherwise.
 */
export function isWallpaperPaintable(
  background: ThemeBackgroundSettings,
  cache: WallpaperCache,
): boolean {
  if (!isMediaBackgroundActive(background)) {
    return false;
  }
  return background.mode !== "preset" || isWallpaperDownloaded(background.presetId, cache);
}

/**
 * Whether chrome and the terminal should composite as glass.
 *
 * The whole rule, in one expression: a wallpaper that can actually be painted,
 * and a user who has not asked to fill surfaces with the theme colour. Nothing
 * else may re-derive this — AppShell computes it once per render and publishes
 * it through `compositionStore`, and every other surface reads that boolean.
 */
export function resolveEffectiveMediaActive(
  background: ThemeBackgroundSettings,
  cache: WallpaperCache,
): boolean {
  return !background.solidSurfaces && isWallpaperPaintable(background, cache);
}

export function applyCacheState(cache: WallpaperCache, dto: WallpaperCacheStateDto): WallpaperCache {
  const paths: Record<string, string> = {};
  for (const entry of dto.entries) {
    paths[entry.id] = entry.path;
  }
  return { ...cache, status: "ready", directory: dto.directory, paths, totalBytes: dto.totalBytes };
}

export function applyProgress(cache: WallpaperCache, event: DownloadProgressEvent): WallpaperCache {
  // Progress for something that is not being downloaded is stale: the
  // completion path already removed the entry, and putting it back would leave
  // a card stuck at 100%.
  if (typeof cache.progress[event.id] !== "number") {
    return cache;
  }
  const percent = Math.max(0, Math.min(100, Math.round(event.percent)));
  if (cache.progress[event.id] === percent) {
    return cache;
  }
  return { ...cache, progress: { ...cache.progress, [event.id]: percent } };
}

export function applyDownloadStarted(cache: WallpaperCache, id: string): WallpaperCache {
  const errors = { ...cache.errors };
  delete errors[id];
  return { ...cache, progress: { ...cache.progress, [id]: 0 }, errors };
}

export function applyDownloadFinished(
  cache: WallpaperCache,
  wallpaper: CachedWallpaper,
): WallpaperCache {
  const progress = { ...cache.progress };
  delete progress[wallpaper.id];
  const errors = { ...cache.errors };
  delete errors[wallpaper.id];
  const alreadyKnown = Boolean(cache.paths[wallpaper.id]);
  return {
    ...cache,
    paths: { ...cache.paths, [wallpaper.id]: wallpaper.path },
    totalBytes: alreadyKnown ? cache.totalBytes : cache.totalBytes + wallpaper.bytes,
    progress,
    errors,
  };
}

export function applyDownloadFailed(
  cache: WallpaperCache,
  id: string,
  message: string,
): WallpaperCache {
  const progress = { ...cache.progress };
  delete progress[id];
  return {
    ...cache,
    progress,
    errors: { ...cache.errors, [id]: message || "原因不明のエラー" },
  };
}

export function applyCacheCleared(cache: WallpaperCache): WallpaperCache {
  // Anything still downloading keeps its progress: it will land in the cache
  // when it finishes, and pretending it is gone would strand the card.
  return { ...cache, paths: {}, totalBytes: 0, errors: {} };
}

export function formatCacheSize(bytes: number): string {
  if (bytes <= 0) {
    return "0 MB";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let state: WallpaperCache = EMPTY_WALLPAPER_CACHE;
const listeners = new Set<() => void>();
let subscribedToProgress = false;
let refreshPromise: Promise<void> | null = null;

function setState(next: WallpaperCache): void {
  if (next === state) {
    return;
  }
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getWallpaperCacheSnapshot(): WallpaperCache {
  return state;
}

export function subscribeWallpaperCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWallpaperCache(): WallpaperCache {
  return useSyncExternalStore(subscribeWallpaperCache, getWallpaperCacheSnapshot, getWallpaperCacheSnapshot);
}

function ensureProgressSubscription(): void {
  if (subscribedToProgress) {
    return;
  }
  subscribedToProgress = true;
  void listen<DownloadProgressEvent>("wallpaper-download-progress", (event) => {
    setState(applyProgress(state, event.payload));
  }).catch((error) => {
    // Losing progress events costs a percentage readout, not the download.
    console.warn("[wallpaper] progress events unavailable:", error);
    subscribedToProgress = false;
  });
}

function describeError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function refreshWallpaperCache(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise;
  }
  ensureProgressSubscription();
  if (state.status === "idle") {
    setState({ ...state, status: "loading" });
  }
  refreshPromise = invoke<WallpaperCacheStateDto>("get_wallpaper_cache_state")
    .then((dto) => {
      setState(applyCacheState(state, dto));
    })
    .catch((error) => {
      // An unreadable cache is the same situation as an empty one: every
      // wallpaper reads as "not downloaded" and the picker still works.
      console.warn("[wallpaper] could not read the cache:", describeError(error));
      setState({ ...state, status: "ready" });
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

/**
 * Downloads a wallpaper if it is not already cached. Resolves to the cached
 * path, or "" when it failed — the reason is left in `errors[id]` so the UI can
 * say what went wrong rather than doing nothing visible.
 */
export async function downloadWallpaper(id: string): Promise<string> {
  if (state.paths[id]) {
    return state.paths[id];
  }
  if (typeof state.progress[id] === "number") {
    return "";
  }
  ensureProgressSubscription();
  setState(applyDownloadStarted(state, id));
  try {
    const wallpaper = await invoke<CachedWallpaper>("download_wallpaper", { id });
    setState(applyDownloadFinished(state, wallpaper));
    return wallpaper.path;
  } catch (error) {
    setState(applyDownloadFailed(state, id, describeError(error)));
    return "";
  }
}

export async function clearWallpaperCache(): Promise<number> {
  const freed = await invoke<number>("clear_wallpaper_cache");
  setState(applyCacheCleared(state));
  return freed;
}
