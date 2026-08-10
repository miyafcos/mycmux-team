import { useMemo, useRef, useState } from "react";
import type { ThemeDefinition } from "../../types";
import { RECOMMENDED_THEMES, THEMES, THEME_GROUPS } from "./themeDefinitions";
import { useThemeStore } from "../../stores/themeStore";
import { useToastStore } from "../../stores/toastStore";

interface ThemeCardEntry {
  cardKey: string;
  theme: ThemeDefinition;
  hint: string;
}

function ThemeSwatch({ theme }: { theme: ThemeDefinition }) {
  return (
    <div
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "6px 8px",
        borderRadius: 5,
        background: theme.chrome.background,
        border: "1px solid var(--cmux-border-hairline, var(--cmux-border))",
      }}
    >
      {[theme.terminal.foreground, theme.chrome.accent, theme.status.done].map((color, index) => (
        <span
          key={index}
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
      ))}
      <span
        style={{
          marginLeft: "auto",
          fontSize: 10,
          color: theme.chrome.text,
          whiteSpace: "nowrap",
        }}
      >
        Aa
      </span>
    </div>
  );
}

function ThemeCard({
  entry,
  selected,
  tabbable,
  onSelect,
  registerRef,
}: {
  entry: ThemeCardEntry;
  selected: boolean;
  tabbable: boolean;
  onSelect: (theme: ThemeDefinition) => void;
  registerRef: (cardKey: string, el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      ref={(el) => registerRef(entry.cardKey, el)}
      onClick={() => onSelect(entry.theme)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
        border: selected
          ? "2px solid var(--cmux-accent)"
          : "1px solid var(--cmux-border)",
        // Keep the box size stable between the 1px and 2px border states.
        margin: selected ? 0 : 1,
        borderRadius: 8,
        background: selected ? "var(--cmux-selected)" : "var(--cmux-surface)",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <ThemeSwatch theme={entry.theme} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cmux-text)", whiteSpace: "nowrap" }}>
          {entry.theme.name}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--cmux-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.hint}
        </span>
      </div>
    </button>
  );
}

const GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))",
  gap: 8,
};

export function ThemePicker() {
  const themeId = useThemeStore((s) => s.themeId);
  const themeTweaks = useThemeStore((s) => s.themeTweaks);
  const setTheme = useThemeStore((s) => s.setTheme);
  const restoreThemeSnapshot = useThemeStore((s) => s.restoreThemeSnapshot);
  const pushToast = useToastStore((s) => s.pushToast);
  const [showAll, setShowAll] = useState(false);

  const themeById = useMemo(() => new Map(THEMES.map((theme) => [theme.id, theme])), []);

  const recommendedEntries = useMemo<ThemeCardEntry[]>(
    () =>
      RECOMMENDED_THEMES.flatMap(({ id, reason }) => {
        const theme = themeById.get(id);
        return theme ? [{ cardKey: `rec-${id}`, theme, hint: reason }] : [];
      }),
    [themeById],
  );

  const groupSections = useMemo(
    () =>
      THEME_GROUPS.map((group) => ({
        group,
        entries: THEMES.filter((theme) => theme.group === group.id).map<ThemeCardEntry>((theme) => ({
          cardKey: `all-${theme.id}`,
          theme,
          hint: theme.description,
        })),
      })),
    [],
  );

  // Flat traversal order for the roving radio focus. A theme can appear twice
  // (recommended + its group) so entries are addressed by cardKey, not id.
  const visibleEntries = useMemo<ThemeCardEntry[]>(
    () =>
      showAll
        ? [...recommendedEntries, ...groupSections.flatMap((section) => section.entries)]
        : recommendedEntries,
    [recommendedEntries, groupSections, showAll],
  );

  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRef = (cardKey: string, el: HTMLButtonElement | null) => {
    if (el) {
      cardRefs.current.set(cardKey, el);
    } else {
      cardRefs.current.delete(cardKey);
    }
  };

  const handleSelect = (theme: ThemeDefinition) => {
    if (theme.id === themeId) {
      return;
    }
    const discardedTweaks = Object.keys(themeTweaks.colors).length > 0;
    setTheme(theme.id);
    if (discardedTweaks) {
      pushToast(`テーマを「${theme.name}」にしました（色の微調整はリセット）`, "info", {
        label: "元に戻す",
        run: restoreThemeSnapshot,
      });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const currentIndex = visibleEntries.findIndex(
      (entry) => cardRefs.current.get(entry.cardKey) === target,
    );
    if (currentIndex < 0) {
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % visibleEntries.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + visibleEntries.length) % visibleEntries.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = visibleEntries.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextEntry = visibleEntries[nextIndex];
    cardRefs.current.get(nextEntry.cardKey)?.focus();
    handleSelect(nextEntry.theme);
  };

  // Exactly one card carries tabindex 0: the first instance of the selected
  // theme, or the first visible card when the active theme is not rendered.
  const tabbableKey =
    visibleEntries.find((entry) => entry.theme.id === themeId)?.cardKey ??
    visibleEntries[0]?.cardKey;

  const renderEntry = (entry: ThemeCardEntry) => (
    <ThemeCard
      key={entry.cardKey}
      entry={entry}
      selected={entry.theme.id === themeId}
      tabbable={entry.cardKey === tabbableKey}
      onSelect={handleSelect}
      registerRef={registerRef}
    />
  );

  return (
    <section style={{ marginBottom: 14 }}>
      <div
        style={{
          marginBottom: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700 }}>テーマ</div>
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          style={{
            height: 26,
            padding: "0 10px",
            border: "1px solid var(--cmux-border)",
            borderRadius: 5,
            background: "transparent",
            color: "var(--cmux-text-secondary)",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {showAll ? "おすすめだけ表示" : `すべてのテーマを表示（${THEMES.length}）`}
        </button>
      </div>
      <div role="radiogroup" aria-label="テーマ" onKeyDown={handleKeyDown}>
        <div style={GRID_STYLE}>{recommendedEntries.map(renderEntry)}</div>
        {showAll
          ? groupSections.map(({ group, entries }) => (
              <div key={group.id} style={{ marginTop: 12 }}>
                <div
                  style={{
                    marginBottom: 6,
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--cmux-text-secondary)" }}>
                    {group.label}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--cmux-text-dim)" }}>{group.hint}</span>
                </div>
                <div style={GRID_STYLE}>{entries.map(renderEntry)}</div>
              </div>
            ))
          : null}
      </div>
    </section>
  );
}
