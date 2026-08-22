import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowDownToLine, Search, TriangleAlert } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ThemeBackgroundSettings } from "../../types";
import { appearanceStrings } from "../../lib/appearanceStrings";
import { SURFACE_OPACITY_MIN } from "../../lib/themeBackgrounds";
import {
  DEFAULT_THEME_BACKGROUND,
  THEME_BACKGROUND_PRESETS,
  isDefaultThemeBackground,
} from "../../lib/themeTweaks";
import { BackgroundPresetSegment } from "./BackgroundPresetSegment";
import type { ThemeBackgroundCategory, ThemeBackgroundTone } from "../../lib/themeTweaks";
import type { WallpaperCardState } from "../../lib/wallpaperCache";
import {
  clearWallpaperCache,
  downloadWallpaper,
  formatCacheSize,
  refreshWallpaperCache,
  useWallpaperCache,
  wallpaperCardState,
} from "../../lib/wallpaperCache";

interface ThemeBackgroundPanelProps {
  background: ThemeBackgroundSettings;
  setThemeBackground: (background: Partial<ThemeBackgroundSettings>) => void;
}

type CategoryFilter = "all" | ThemeBackgroundCategory;
type ToneFilter = "all" | ThemeBackgroundTone;

const CATEGORY_FILTERS: { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "macos", label: "macOS" },
  { value: "warp", label: "Warp" },
  { value: "win11", label: "Windows" },
  { value: "catppuccin", label: "Catppuccin" },
];

const TONE_FILTERS: { value: ToneFilter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "dark", label: "暗め" },
  { value: "mid", label: "中間" },
  { value: "bright", label: "明るめ" },
];

const VISUAL_BACKGROUND_DEFAULTS = {
  imageOpacity: DEFAULT_THEME_BACKGROUND.imageOpacity,
  imageBlur: DEFAULT_THEME_BACKGROUND.imageBlur,
  wallpaperTone: DEFAULT_THEME_BACKGROUND.wallpaperTone,
  panelOpacity: DEFAULT_THEME_BACKGROUND.panelOpacity,
  terminalOpacity: DEFAULT_THEME_BACKGROUND.terminalOpacity,
};

function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// The tone slider is signed: left darkens the wallpaper, right washes it
// toward the theme's paper colour, centre leaves it alone.
function toneLabel(value: number): string {
  const percent = Math.round(Math.abs(value) * 100);
  if (percent === 0) {
    return "そのまま";
  }
  return value < 0 ? `暗く ${percent}%` : `明るく ${percent}%`;
}

function chipStyle(active: boolean): CSSProperties {
  return {
    height: 28,
    border: active ? "1px solid var(--cmux-accent)" : "1px solid var(--cmux-border)",
    borderRadius: 7,
    background: active ? "var(--cmux-selected)" : "transparent",
    color: active ? "var(--cmux-accent-text)" : "var(--cmux-text-secondary)",
    cursor: "pointer",
    padding: "0 10px",
    fontSize: 11,
    fontWeight: active ? 700 : 500,
    whiteSpace: "nowrap",
  };
}

/**
 * The state of a wallpaper drawn onto its own card.
 *
 * The grey arrow doubles as the "not downloaded yet" marker, which is why it
 * is not a button: the whole card is the target, and a 16px arrow would be a
 * miserable one.
 */
function WallpaperStateBadge({ state, percent }: { state: WallpaperCardState; percent: number }) {
  if (state === "downloaded") {
    return null;
  }

  const isFailure = state === "failed";
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 5,
        right: 5,
        zIndex: 2,
        minWidth: 22,
        height: 22,
        padding: state === "downloading" ? "0 5px" : 0,
        borderRadius: 11,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.55)",
        color: isFailure ? "var(--cmux-red)" : "rgba(255, 255, 255, 0.72)",
        fontSize: 10,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {state === "downloading" ? (
        `${percent}%`
      ) : isFailure ? (
        <TriangleAlert size={13} />
      ) : (
        <ArrowDownToLine size={13} />
      )}
    </span>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
  disabled = false,
  disabledHint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange: (value: number) => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, opacity: disabled ? 0.55 : 1 }} title={disabled ? disabledHint : undefined}>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11 }}>
        <span style={{ color: "var(--cmux-text-secondary)" }}>{label}</span>
        <span style={{ color: "var(--cmux-text-tertiary)" }}>{disabled && disabledHint ? disabledHint : displayValue}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function ThemeBackgroundPanel({
  background,
  setThemeBackground,
}: ThemeBackgroundPanelProps) {
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [toneFilter, setToneFilter] = useState<ToneFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [cacheNotice, setCacheNotice] = useState("");
  const wallpaperCache = useWallpaperCache();
  const backgroundChanged = !isDefaultThemeBackground(background);
  const showVisualControls = background.mode !== "solid";
  const modeLabel =
    background.mode === "image" && background.imagePath
      ? "画像"
      : background.mode === "solid"
        ? "単色"
        : "プリセット";

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setSearchQuery(searchInput.trim().toLowerCase());
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

  useEffect(() => {
    void refreshWallpaperCache();
  }, []);

  const filteredPresets = useMemo(() => {
    return THEME_BACKGROUND_PRESETS.filter((preset) => {
      if (categoryFilter !== "all" && preset.category !== categoryFilter) {
        return false;
      }
      if (toneFilter !== "all" && preset.tone !== toneFilter) {
        return false;
      }
      if (!searchQuery) {
        return true;
      }
      return `${preset.label} ${preset.description}`.toLowerCase().includes(searchQuery);
    });
  }, [categoryFilter, searchQuery, toneFilter]);

  const failedDownloads = useMemo(
    () => THEME_BACKGROUND_PRESETS.filter((preset) => wallpaperCache.errors[preset.id]),
    [wallpaperCache.errors],
  );
  const downloadedCount = Object.keys(wallpaperCache.paths).length;
  const selectedPreset = THEME_BACKGROUND_PRESETS.find((preset) => preset.id === background.presetId);
  // A wallpaper chosen on an older build is still chosen; it is just being
  // fetched. Saying so beats leaving the user staring at a flat colour.
  const selectedIsPending =
    background.mode === "preset" &&
    selectedPreset !== undefined &&
    !wallpaperCache.paths[background.presetId] &&
    !wallpaperCache.errors[background.presetId];

  const applySolid = () => {
    setThemeBackground({ mode: "solid", imagePath: "" });
  };

  // Downloaded wallpapers apply instantly; the rest are fetched first and
  // applied only once they are really on disk, so the app never switches to a
  // wallpaper it cannot paint. A failure leaves the current choice alone and
  // says why on the card and in the list below the grid.
  const applyPreset = async (presetId: string) => {
    if (!wallpaperCache.paths[presetId]) {
      const path = await downloadWallpaper(presetId);
      if (!path) {
        return;
      }
    }
    setThemeBackground({
      mode: "preset",
      presetId,
      imagePath: "",
      ...VISUAL_BACKGROUND_DEFAULTS,
    });
  };

  // Deleting the files while a preset is still applied would just download it
  // again, so the background drops to solid. `presetId` is kept, which means
  // one click on the same card brings it back.
  const removeDownloads = async () => {
    setIsClearingCache(true);
    setCacheNotice("");
    try {
      const freed = await clearWallpaperCache();
      const wasUsingPreset = background.mode === "preset";
      if (wasUsingPreset) {
        setThemeBackground({ mode: "solid", imagePath: "" });
      }
      setCacheNotice(
        wasUsingPreset
          ? `${formatCacheSize(freed)} 分を削除し、背景を単色に戻しました。カードを押すと再取得できます。`
          : `${formatCacheSize(freed)} 分を削除しました。`,
      );
    } catch (error) {
      setCacheNotice(
        `削除できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsClearingCache(false);
    }
  };

  const applyImagePath = (imagePath: string) => {
    const trimmed = imagePath.trim();
    if (!trimmed) {
      setThemeBackground({ mode: "preset", imagePath: "" });
      return;
    }

    setThemeBackground({
      mode: "image",
      imagePath: trimmed,
      ...VISUAL_BACKGROUND_DEFAULTS,
    });
  };

  const chooseImage = async () => {
    setIsPickingImage(true);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
          },
        ],
      });
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (typeof selectedPath === "string" && selectedPath.trim()) {
        applyImagePath(selectedPath);
      }
    } catch (error) {
      console.warn("[theme] Failed to choose background image:", error);
    } finally {
      setIsPickingImage(false);
    }
  };

  return (
    <section
      style={{
        border: "1px solid var(--cmux-border)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--cmux-surface)",
        marginBottom: 14,
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--cmux-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700 }}>背景</div>
        <div style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
          {modeLabel}{backgroundChanged ? " / 変更あり" : ""}
        </div>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={applySolid} style={chipStyle(background.mode === "solid")}>
            単色
          </button>
          <button
            type="button"
            onClick={chooseImage}
            disabled={isPickingImage}
            style={{
              ...chipStyle(background.mode === "image"),
              cursor: isPickingImage ? "default" : "pointer",
            }}
          >
            {isPickingImage ? "選択中..." : "画像を選ぶ"}
          </button>
          <button
            type="button"
            onClick={() => setThemeBackground(DEFAULT_THEME_BACKGROUND)}
            disabled={!backgroundChanged}
            style={{
              height: 28,
              border: "1px solid var(--cmux-border)",
              borderRadius: 7,
              background: "transparent",
              color: backgroundChanged ? "var(--cmux-text-secondary)" : "var(--cmux-text-dim)",
              cursor: backgroundChanged ? "pointer" : "default",
              padding: "0 10px",
              fontSize: 11,
              whiteSpace: "nowrap",
            }}
          >
            リセット
          </button>
        </div>

        <BackgroundPresetSegment background={background} onChange={setThemeBackground} />

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {CATEGORY_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setCategoryFilter(filter.value)}
                style={chipStyle(categoryFilter === filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {TONE_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setToneFilter(filter.value)}
                style={chipStyle(toneFilter === filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <label style={{ position: "relative", display: "block" }}>
            <Search
              size={14}
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 9,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--cmux-text-tertiary)",
                pointerEvents: "none",
              }}
            />
            <input
              type="search"
              value={searchInput}
              placeholder="プリセットを検索"
              onChange={(event) => setSearchInput(event.target.value)}
              style={{
                width: "100%",
                height: 30,
                border: "1px solid var(--cmux-border)",
                borderRadius: 7,
                background: "color-mix(in srgb, var(--cmux-bg) 84%, transparent)",
                color: "var(--cmux-text-secondary)",
                padding: "0 9px 0 30px",
                fontSize: 11,
                outline: "none",
              }}
            />
          </label>
        </div>

        <div style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
          {filteredPresets.length} / {THEME_BACKGROUND_PRESETS.length} 件のプリセット
        </div>

        {selectedIsPending && (
          <div
            style={{
              border: "1px solid var(--cmux-border)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 11,
              color: "var(--cmux-text-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>
              選択中の「{selectedPreset?.label}」はまだダウンロードされていません。
              {typeof wallpaperCache.progress[background.presetId] === "number"
                ? `ダウンロード中 ${wallpaperCache.progress[background.presetId]}%`
                : "取得できるまで単色で表示します。"}
            </span>
            <button
              type="button"
              onClick={() => void downloadWallpaper(background.presetId)}
              disabled={typeof wallpaperCache.progress[background.presetId] === "number"}
              style={{
                height: 26,
                border: "1px solid var(--cmux-border)",
                borderRadius: 6,
                background: "transparent",
                color: "var(--cmux-text-secondary)",
                cursor: "pointer",
                padding: "0 10px",
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              今すぐ取得
            </button>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {filteredPresets.map((preset) => {
            const active = background.mode === "preset" && background.presetId === preset.id;
            const cardState = wallpaperCardState(preset.id, wallpaperCache);
            const percent = wallpaperCache.progress[preset.id] ?? 0;
            const failure = wallpaperCache.errors[preset.id] ?? "";
            const title = failure
              ? `${preset.label} - ダウンロードに失敗しました: ${failure}`
              : cardState === "notDownloaded"
                ? `${preset.label} - ${preset.description} (クリックでダウンロード)`
                : `${preset.label} - ${preset.description}`;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => void applyPreset(preset.id)}
                disabled={cardState === "downloading"}
                data-wallpaper-id={preset.id}
                data-wallpaper-state={cardState}
                title={title}
                style={{
                  minHeight: 66,
                  border: active ? "2px solid var(--cmux-accent)" : "1px solid var(--cmux-border)",
                  borderRadius: 8,
                  padding: 6,
                  background: "var(--cmux-surface)",
                  color: "var(--cmux-text)",
                  cursor: "pointer",
                  textAlign: "left",
                  overflow: "hidden",
                  position: "relative",
                  display: "flex",
                  alignItems: "flex-end",
                }}
              >
                <img
                  src={preset.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: "center",
                  }}
                />
                <WallpaperStateBadge state={cardState} percent={percent} />
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: active ? "rgba(0, 0, 0, 0.12)" : "rgba(0, 0, 0, 0.03)",
                  }}
                />
                <span
                  style={{
                    position: "relative",
                    zIndex: 1,
                    display: "inline-block",
                    maxWidth: "100%",
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "rgba(0, 0, 0, 0.6)",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "#fff",
                    textShadow: "0 1px 2px rgba(0, 0, 0, 0.55)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {preset.label}
                </span>
              </button>
            );
          })}
        </div>

        {filteredPresets.length === 0 && (
          <div
            style={{
              border: "1px dashed var(--cmux-border)",
              borderRadius: 8,
              color: "var(--cmux-text-tertiary)",
              fontSize: 11,
              padding: 12,
              textAlign: "center",
            }}
          >
            条件に一致するプリセットがありません。
          </div>
        )}

        {/* A download that fails must say so and stay retryable. */}
        {failedDownloads.length > 0 && (
          <div
            style={{
              border: "1px solid var(--cmux-red)",
              borderRadius: 8,
              padding: "8px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {failedDownloads.map((preset) => (
              <div
                key={preset.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                }}
              >
                <span style={{ color: "var(--cmux-text-secondary)", minWidth: 0 }}>
                  <span style={{ color: "var(--cmux-red)", fontWeight: 700 }}>
                    「{preset.label}」のダウンロードに失敗しました
                  </span>
                  <br />
                  {wallpaperCache.errors[preset.id]}
                </span>
                <button
                  type="button"
                  onClick={() => void downloadWallpaper(preset.id)}
                  style={{
                    height: 26,
                    border: "1px solid var(--cmux-border)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "var(--cmux-text-secondary)",
                    cursor: "pointer",
                    padding: "0 10px",
                    fontSize: 11,
                    whiteSpace: "nowrap",
                  }}
                >
                  再試行
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8 }}>
          <input
            type="text"
            value={background.imagePath}
            placeholder="画像パスを貼り付け"
            onChange={(event) => applyImagePath(event.target.value)}
            style={{
              minWidth: 0,
              height: 30,
              border: "1px solid var(--cmux-border)",
              borderRadius: 6,
              background: "color-mix(in srgb, var(--cmux-bg) 84%, transparent)",
              color: "var(--cmux-text-secondary)",
              padding: "0 9px",
              fontSize: 11,
            }}
          />
          <button
            type="button"
            onClick={() => setThemeBackground({ mode: "preset", imagePath: "" })}
            disabled={!background.imagePath}
            style={{
              height: 30,
              border: "1px solid var(--cmux-border)",
              borderRadius: 6,
              background: "transparent",
              color: background.imagePath ? "var(--cmux-text-secondary)" : "var(--cmux-text-dim)",
              cursor: background.imagePath ? "pointer" : "default",
              padding: "0 10px",
              fontSize: 11,
            }}
          >
            クリア
          </button>
        </div>

        {showVisualControls && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, color: "var(--cmux-text-tertiary)" }}>
              {appearanceStrings.backgroundOpacityHint}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
                gap: 10,
              }}
            >
              <RangeControl
                label="画像の不透明度"
                value={background.imageOpacity}
                min={0.1}
                max={1}
                step={0.01}
                displayValue={percentLabel(background.imageOpacity)}
                onChange={(value) => setThemeBackground({ imageOpacity: value })}
              />
              <RangeControl
                label="ぼかし"
                value={background.imageBlur}
                min={0}
                max={32}
                step={1}
                displayValue={`${Math.round(background.imageBlur)}px`}
                onChange={(value) => setThemeBackground({ imageBlur: value })}
              />
              <RangeControl
                label="壁紙の色調"
                value={background.wallpaperTone}
                min={-0.85}
                max={0.85}
                step={0.01}
                displayValue={toneLabel(background.wallpaperTone)}
                onChange={(value) => setThemeBackground({ wallpaperTone: value })}
              />
              <RangeControl
                label="パネル"
                value={background.panelOpacity}
                min={SURFACE_OPACITY_MIN}
                max={1}
                step={0.01}
                displayValue={percentLabel(background.panelOpacity)}
                onChange={(value) => setThemeBackground({ panelOpacity: value })}
                disabled={background.solidSurfaces}
                disabledHint={appearanceStrings.solidSurfacesSlidersDisabled}
              />
              <RangeControl
                label="ターミナル"
                value={background.terminalOpacity}
                min={SURFACE_OPACITY_MIN}
                max={1}
                step={0.01}
                displayValue={percentLabel(background.terminalOpacity)}
                onChange={(value) => setThemeBackground({ terminalOpacity: value })}
                disabled={background.solidSurfaces}
                disabledHint={appearanceStrings.solidSurfacesSlidersDisabled}
              />
            </div>
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid var(--cmux-border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 11, color: "var(--cmux-text-tertiary)", minWidth: 0 }}>
              壁紙は選んだときにダウンロードされます。{downloadedCount} 件 (
              {formatCacheSize(wallpaperCache.totalBytes)}) を保存中。
            </span>
            <button
              type="button"
              onClick={() => void removeDownloads()}
              disabled={isClearingCache || downloadedCount === 0}
              style={{
                height: 28,
                border: "1px solid var(--cmux-border)",
                borderRadius: 7,
                background: "transparent",
                color:
                  isClearingCache || downloadedCount === 0
                    ? "var(--cmux-text-dim)"
                    : "var(--cmux-text-secondary)",
                cursor: isClearingCache || downloadedCount === 0 ? "default" : "pointer",
                padding: "0 10px",
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              {isClearingCache ? "削除中..." : "ダウンロード済みの壁紙を削除"}
            </button>
          </div>
          {cacheNotice && (
            <div style={{ fontSize: 11, color: "var(--cmux-text-secondary)" }}>{cacheNotice}</div>
          )}
        </div>
      </div>
    </section>
  );
}
