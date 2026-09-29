import { useEffect, useRef } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { ThemeBackgroundSettings } from "../../types";
import { appearanceStrings } from "../../lib/appearanceStrings";
import {
  applyBackgroundPreset,
  NAMED_BACKGROUND_PRESETS,
  resolveBackgroundPreset,
  type BackgroundPresetId,
  type NamedBackgroundPreset,
} from "../../lib/theme/backgroundPresets";

interface BackgroundPresetSegmentProps {
  background: ThemeBackgroundSettings;
  onChange: (background: Partial<ThemeBackgroundSettings>) => void;
}

const PRESET_LABELS: Record<BackgroundPresetId, string> = {
  solid: appearanceStrings.backgroundPresetSolid,
  frosted: appearanceStrings.backgroundPresetFrosted,
  clear: appearanceStrings.backgroundPresetClear,
  custom: appearanceStrings.backgroundPresetCustom,
};

const GROUP_STYLE: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: 3,
  border: "1px solid var(--cmux-border)",
  borderRadius: 7,
  background: "color-mix(in srgb, var(--cmux-text) 4%, transparent)",
};

const HINT_STYLE: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  lineHeight: 1.4,
  color: "var(--cmux-text-tertiary)",
  overflowWrap: "anywhere",
};

let lastNamedPreset: NamedBackgroundPreset = "frosted";

function rememberNamedPreset(id: NamedBackgroundPreset): void {
  lastNamedPreset = id;
}

export function BackgroundPresetSegment({ background, onChange }: BackgroundPresetSegmentProps) {
  const current = resolveBackgroundPreset(background);
  useEffect(() => {
    if (current !== "custom") {
      rememberNamedPreset(current);
    }
  }, [current]);

  const options: BackgroundPresetId[] =
    current === "custom" ? [...NAMED_BACKGROUND_PRESETS, "custom"] : [...NAMED_BACKGROUND_PRESETS];
  const buttonRefs = useRef(new Map<BackgroundPresetId, HTMLButtonElement>());

  const applyNamed = (id: NamedBackgroundPreset) => {
    rememberNamedPreset(id);
    onChange(applyBackgroundPreset(id));
  };

  const select = (id: BackgroundPresetId) => {
    if (id === "custom") {
      // The custom radio disappears once a named preset applies; move focus
      // with it so keyboard users are not dropped out of the radiogroup.
      const target = lastNamedPreset;
      applyNamed(target);
      queueMicrotask(() => buttonRefs.current.get(target)?.focus());
      return;
    }
    if (id === current) {
      return;
    }
    applyNamed(id);
  };

  const registerRef = (id: BackgroundPresetId, el: HTMLButtonElement | null) => {
    if (el) {
      buttonRefs.current.set(id, el);
    } else {
      buttonRefs.current.delete(id);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    if (event.key === "ArrowRight") {
      delta = 1;
    } else if (event.key === "ArrowLeft") {
      delta = -1;
    } else {
      return;
    }
    const active = document.activeElement;
    const index = options.findIndex((id) => buttonRefs.current.get(id) === active);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    const next = options[(index + delta + options.length) % options.length];
    select(next);
    queueMicrotask(() => {
      const focusId = next === "custom" ? lastNamedPreset : next;
      buttonRefs.current.get(focusId)?.focus();
    });
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label={appearanceStrings.backgroundPresetAriaLabel}
        onKeyDown={handleKeyDown}
        style={{
          ...GROUP_STYLE,
          gridTemplateColumns: `repeat(${options.length}, 1fr)`,
        }}
      >
        {options.map((id) => {
          const active = current === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              ref={(el) => registerRef(id, el)}
              onClick={() => select(id)}
              style={{
                height: 28,
                border: "none",
                borderRadius: 5,
                background: active ? "var(--cmux-selected)" : "transparent",
                color: active ? "var(--cmux-accent-text)" : "var(--cmux-text-secondary)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: active ? 700 : 500,
                whiteSpace: "nowrap",
              }}
            >
              {PRESET_LABELS[id]}
            </button>
          );
        })}
      </div>
      <div style={HINT_STYLE}>
        {current === "custom"
          ? appearanceStrings.backgroundPresetCustomHint
          : appearanceStrings.backgroundPresetHint}
      </div>
    </div>
  );
}
