import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Search } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ThemeBackgroundSettings } from "../../types";
import {
  DEFAULT_THEME_BACKGROUND,
  THEME_BACKGROUND_PRESETS,
  isDefaultThemeBackground,
} from "../../lib/themeTweaks";
import type { ThemeBackgroundCategory, ThemeBackgroundTone } from "../../lib/themeTweaks";

interface ThemeBackgroundPanelProps {
  background: ThemeBackgroundSettings;
  setThemeBackground: (background: Partial<ThemeBackgroundSettings>) => void;
}

type CategoryFilter = "all" | ThemeBackgroundCategory;
type ToneFilter = "all" | ThemeBackgroundTone;

const CATEGORY_FILTERS: { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "macos", label: "macOS" },
  { value: "warp", label: "Warp" },
  { value: "win11", label: "Windows" },
  { value: "catppuccin", label: "Catppuccin" },
];

const TONE_FILTERS: { value: ToneFilter; label: string }[] = [
  { value: "all", label: "All tones" },
  { value: "dark", label: "Dark" },
  { value: "mid", label: "Mid" },
  { value: "bright", label: "Bright" },
];

const VISUAL_BACKGROUND_DEFAULTS = {
  imageOpacity: DEFAULT_THEME_BACKGROUND.imageOpacity,
  imageBlur: DEFAULT_THEME_BACKGROUND.imageBlur,
  imageDim: DEFAULT_THEME_BACKGROUND.imageDim,
  panelOpacity: DEFAULT_THEME_BACKGROUND.panelOpacity,
  terminalOpacity: DEFAULT_THEME_BACKGROUND.terminalOpacity,
};

function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function chipStyle(active: boolean): CSSProperties {
  return {
    height: 28,
    border: active ? "1px solid var(--cmux-accent)" : "1px solid var(--cmux-border)",
    borderRadius: 7,
    background: active ? "var(--cmux-selected)" : "transparent",
    color: active ? "var(--cmux-accent)" : "var(--cmux-text-secondary)",
    cursor: "pointer",
    padding: "0 10px",
    fontSize: 11,
    fontWeight: active ? 700 : 500,
    whiteSpace: "nowrap",
  };
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11 }}>
        <span style={{ color: "var(--cmux-text-secondary)" }}>{label}</span>
        <span style={{ color: "var(--cmux-text-tertiary)" }}>{displayValue}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
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
  const backgroundChanged = !isDefaultThemeBackground(background);
  const showVisualControls = background.mode !== "solid";
  const modeLabel =
    background.mode === "image" && background.imagePath
      ? "Image"
      : background.mode === "solid"
        ? "Solid"
        : "Preset";

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setSearchQuery(searchInput.trim().toLowerCase());
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

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

  const applySolid = () => {
    setThemeBackground({ mode: "solid", imagePath: "" });
  };

  const applyPreset = (presetId: string) => {
    setThemeBackground({
      mode: "preset",
      presetId,
      imagePath: "",
      ...VISUAL_BACKGROUND_DEFAULTS,
    });
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
        <div style={{ fontSize: 12, fontWeight: 700 }}>Background</div>
        <div style={{ fontSize: 10, color: "var(--cmux-text-tertiary)" }}>
          {modeLabel}{backgroundChanged ? " / changed" : ""}
        </div>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={applySolid} style={chipStyle(background.mode === "solid")}>
            Solid
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
            {isPickingImage ? "Picking..." : "Choose image"}
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
            Reset
          </button>
        </div>

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
              placeholder="Search presets"
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

        <div style={{ fontSize: 10, color: "var(--cmux-text-tertiary)" }}>
          {filteredPresets.length} / {THEME_BACKGROUND_PRESETS.length} presets
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {filteredPresets.map((preset) => {
            const active = background.mode === "preset" && background.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                title={`${preset.label} - ${preset.description}`}
                style={{
                  minHeight: 66,
                  border: active ? "2px solid var(--cmux-accent)" : "1px solid var(--cmux-border)",
                  borderRadius: 8,
                  padding: 6,
                  background: "color-mix(in srgb, var(--cmux-bg) 82%, transparent)",
                  color: "#fff",
                  cursor: "pointer",
                  textAlign: "left",
                  overflow: "hidden",
                  position: "relative",
                  display: "flex",
                  alignItems: "flex-end",
                }}
              >
                <img
                  src={preset.imageUrl}
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
                    background: active ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.42)",
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
            No presets match the current filters.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8 }}>
          <input
            type="text"
            value={background.imagePath}
            placeholder="Paste image path"
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
            Clear
          </button>
        </div>

        {showVisualControls && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
              gap: 10,
            }}
          >
            <RangeControl
              label="Image opacity"
              value={background.imageOpacity}
              min={0.1}
              max={1}
              step={0.01}
              displayValue={percentLabel(background.imageOpacity)}
              onChange={(value) => setThemeBackground({ imageOpacity: value })}
            />
            <RangeControl
              label="Blur"
              value={background.imageBlur}
              min={0}
              max={32}
              step={1}
              displayValue={`${Math.round(background.imageBlur)}px`}
              onChange={(value) => setThemeBackground({ imageBlur: value })}
            />
            <RangeControl
              label="Dim"
              value={background.imageDim}
              min={0}
              max={0.85}
              step={0.01}
              displayValue={percentLabel(background.imageDim)}
              onChange={(value) => setThemeBackground({ imageDim: value })}
            />
            <RangeControl
              label="Panels"
              value={background.panelOpacity}
              min={0.2}
              max={1}
              step={0.01}
              displayValue={percentLabel(background.panelOpacity)}
              onChange={(value) => setThemeBackground({ panelOpacity: value })}
            />
            <RangeControl
              label="Terminal"
              value={background.terminalOpacity}
              min={0.2}
              max={1}
              step={0.01}
              displayValue={percentLabel(background.terminalOpacity)}
              onChange={(value) => setThemeBackground({ terminalOpacity: value })}
            />
          </div>
        )}
      </div>
    </section>
  );
}
