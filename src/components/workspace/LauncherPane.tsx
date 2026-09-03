/**
 * The launch picker a fresh tab opens on.
 *
 * Replaces the ANSI menu `launcher.sh` drew inside the PTY, which mouse reports
 * never reached and which listed 19 rows flat with no scroll. This pane only
 * decides *what* to start: the choice leaves as `MYCMUX_LAUNCH_TARGET` and
 * `launcher.sh` still does the spawning, so session numbering, cwd restore and
 * env preprocessing stay where they are.
 *
 * Designed against 240px — the width one pane gets in an eight-way split, which
 * is the real working layout. Everything here is a single column for that
 * reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AgentKindIcon } from "../icons/AgentIcons";
import {
  buildLaunchSpecEnv,
  getCatalogEntry,
  isValidLaunchSpecValue,
} from "../../lib/agentCatalog";
import { agentIdForSessionKind } from "../../lib/agentSessionConfig";
import {
  crsmListSessions,
  listLauncherDirs,
  type CrsmSessionEntry,
  type LauncherDirs,
} from "../../lib/ipc";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  dirItems,
  launchItems,
  middleEllipsis,
  previewLine,
  searchItems,
  tailPath,
  type LauncherDirItem,
  type LauncherItem,
  type LauncherLaunchItem,
  type LauncherResumeItem,
} from "./launcherModel";
import { launcherStrings as S } from "./launcherStrings";

interface LauncherPaneProps {
  workspaceId: string;
  paneId: string;
  /** This launcher tab; it is removed once something is launched. */
  tabId: string;
  /** Claims the pane focus on click, the way a terminal does when typed into. */
  sessionId: string;
  /**
   * Whether this pane holds the app focus. Only the focused pane draws a
   * selection: every launcher showing its own ring at once made it look like
   * all of them were selected, and the arrow keys only ever reach one.
   */
  isActive: boolean;
  /** Where a launch lands until a directory row changes it. */
  cwd?: string;
}

/** How many rows a section shows before "すべて" expands it. */
const SECTION_PREVIEW = 5;

/**
 * How many sessions the launcher asks CRSM for.
 *
 * Ctrl+P fetches a thousand and pages through them; this list only ever shows
 * the first handful, and the pane has to paint immediately. Anything past the
 * preview is the palette's job, which is what the "すべて" link opens.
 */
const RESUME_FETCH_LIMIT = 40;

/** Section keys that can be switched off alongside individual catalog rows. */
export const LAUNCHER_SECTION_IDS = ["resume", "dev", "anken"] as const;

/**
 * Clicking anything in this pane must not move the focus off the search box.
 *
 * A button that takes focus keeps the browser's focus ring after the click, so
 * every chip that had been pressed looked selected at once — and worse, the
 * arrow keys then went to that button instead of the pane, which is why the
 * selection ring stopped moving. Suppressing mousedown's default keeps the
 * caret where it is; the click itself still fires.
 */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

const row: CSSProperties = {
  outline: "none",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 10px",
  cursor: "pointer",
  background: "transparent",
  border: "none",
  // The selected row marks itself with this edge, so the gutter is reserved on
  // every row — otherwise selecting one would shift the whole list sideways.
  borderLeftWidth: 2,
  borderLeftStyle: "solid",
  borderLeftColor: "transparent",
  width: "100%",
  textAlign: "left",
  font: "inherit",
  color: "var(--cmux-text)",
};

const rowSelected: CSSProperties = {
  background: "var(--cmux-selected)",
  borderLeftColor: "var(--cmux-accent)",
};

const primaryText: CSSProperties = {
  fontSize: "var(--cmux-font-size-sm)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  flex: "1 1 auto",
  minWidth: 0,
};

/** Second line of a resume row: what the conversation opened with. */
const secondaryText: CSSProperties = {
  display: "block",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-dim)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const markText: CSSProperties = {
  flex: "0 0 auto",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-tertiary)",
  fontFamily: "var(--cmux-font-mono)",
};

const sectionHeading: CSSProperties = {
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-tertiary)",
  padding: "11px 10px 4px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
};

const moreButton: CSSProperties = {
  outline: "none",
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-dim)",
  cursor: "pointer",
};

/**
 * The pill's outline lives on the wrapper, not on the two buttons inside it,
 * so a focused chip lights up as one shape. Drawing a border per button left
 * the label ringed in accent while the "⋯" beside it kept the idle grey, and
 * read as two controls that happened to touch.
 */
const chipShell: CSSProperties = {
  outline: "none",
  display: "inline-flex",
  alignItems: "stretch",
  // Longhand on purpose: the selected state overrides borderColor, and a
  // shorthand "border" declared alongside it can win the cascade instead,
  // which left every chip in the idle grey no matter what was picked.
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--cmux-border)",
  borderRadius: 999,
  overflow: "hidden",
  maxWidth: "100%",
  background: "transparent",
};

const chipBody: CSSProperties = {
  outline: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: 0,
  borderRadius: 0,
  padding: "3px 4px",
  fontFamily: "inherit",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  background: "transparent",
  minWidth: 0,
};

const chipMore: CSSProperties = {
  outline: "none",
  border: 0,
  borderLeftWidth: 1,
  borderLeftStyle: "solid",
  borderLeftColor: "var(--cmux-border)",
  borderRadius: 0,
  padding: "0 6px",
  fontFamily: "inherit",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-tertiary)",
  cursor: "pointer",
  background: "transparent",
  flex: "0 0 auto",
};

/**
 * Model and effort are picked from buttons, not a <datalist> or a <select>.
 * Those are drawn by WebView2 itself: the popup ignores the pane width and
 * arrives in the browser's own light palette, so on a 240px dark pane it
 * spilled sideways in pale text on white.
 */
const specChip: CSSProperties = {
  outline: "none",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--cmux-border)",
  borderRadius: 999,
  padding: "3px 8px",
  fontFamily: "inherit",
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-secondary)",
  cursor: "pointer",
  background: "transparent",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const specChipOn: CSSProperties = {
  borderColor: "var(--cmux-accent)",
  color: "var(--cmux-text)",
  background: "var(--cmux-selected)",
};

const specLabel: CSSProperties = {
  fontSize: "var(--cmux-font-size-xs)",
  color: "var(--cmux-text-tertiary)",
};

const specControl: CSSProperties = {
  backgroundColor: "transparent",
  color: "var(--cmux-text)",
  colorScheme: "inherit",
  border: "1px solid var(--cmux-border)",
  borderRadius: 4,
  padding: "4px 6px",
  fontSize: "var(--cmux-font-size-xs)",
  fontFamily: "var(--cmux-font-mono)",
  outline: "none",
  boxSizing: "border-box",
  width: "100%",
};

function FolderGlyph({ anken }: { anken: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke={anken ? "var(--cmux-accent)" : "currentColor"}
      strokeWidth="1.4"
      style={{ opacity: 0.65, flex: "0 0 auto" }}
      aria-hidden="true"
    >
      <path d="M1.5 4.5h5l1.5 2h6.5v7h-13z" />
    </svg>
  );
}

export default function LauncherPane({
  workspaceId,
  paneId,
  tabId,
  sessionId,
  isActive,
  cwd,
}: LauncherPaneProps) {
  const [query, setQuery] = useState("");
  const [dirs, setDirs] = useState<LauncherDirs | null>(null);
  const [targetCwd, setTargetCwd] = useState<string | undefined>(cwd);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [specTarget, setSpecTarget] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sessions, setSessions] = useState<CrsmSessionEntry[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const hiddenIds = useSettingsStore((s) => s.launcherHiddenIds);
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  // Kind filters are shared with Ctrl+P on purpose: the same session should not
  // be listed in one place and hidden in the other.
  const crsmShowClaude = useSettingsStore((s) => s.crsmShowClaude);
  const crsmShowCodex = useSettingsStore((s) => s.crsmShowCodex);
  const crsmShowClaudeCodex = useSettingsStore((s) => s.crsmShowClaudeCodex);
  const hideSessionsWithoutUserMessages = useSettingsStore((s) => s.hideSessionsWithoutUserMessages);

  const addTabToPaneWithOptions = useWorkspaceLayoutStore((s) => s.addTabToPaneWithOptions);
  const addWebTabToPane = useWorkspaceLayoutStore((s) => s.addWebTabToPane);
  const removeTabFromPane = useWorkspaceLayoutStore((s) => s.removeTabFromPane);

  const setActivePaneId = useUiStore((s) => s.setActivePaneId);

  /**
   * A terminal claims the pane when it is typed into; this pane has to say so
   * itself. Without it, clicking a launcher left the app focus on whichever
   * pane held it before — the pane border never moved, and the arrow keys kept
   * going somewhere else.
   */
  const claimFocus = useCallback(() => {
    setActivePaneId(sessionId);
    inputRef.current?.focus();
  }, [setActivePaneId, sessionId]);

  // S2: the pane is opened to be typed into — but only once it is the focused
  // one, or opening a background pane would steal the caret.
  useEffect(() => {
    if (isActive) inputRef.current?.focus();
  }, [isActive]);

  useEffect(() => {
    let cancelled = false;
    listLauncherDirs()
      .then((loaded) => {
        if (!cancelled) setDirs(loaded);
      })
      .catch(() => {
        // A missing roots file is normal on a fresh machine; the agent and web
        // sections still stand on their own.
        if (!cancelled) setDirs({ dev: [], anken: [], mru: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allLaunch = useMemo(
    () => launchItems().filter((item) => !hidden.has(item.target)),
    [hidden],
  );
  const agents = useMemo(() => allLaunch.filter((item) => item.kind === "agent"), [allLaunch]);
  const webs = useMemo(() => allLaunch.filter((item) => item.kind === "web"), [allLaunch]);
  const { dev, anken } = useMemo(() => dirItems(dirs), [dirs]);

  const showResume = !hidden.has("resume");
  const showDev = !hidden.has("dev");
  const showAnken = !hidden.has("anken");

  useEffect(() => {
    if (!showResume) {
      setSessions([]);
      return undefined;
    }
    let cancelled = false;
    // Not awaited before the first paint: the catalog is already on screen and
    // this list drops in when it arrives.
    crsmListSessions(undefined, RESUME_FETCH_LIMIT, false)
      .then((list) => { if (!cancelled) setSessions(list); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, [showResume]);

  const resumes: LauncherResumeItem[] = useMemo(() => {
    if (!showResume) return [];
    const kindShown = (kind: CrsmSessionEntry["kind"]): boolean => {
      if (kind === "claude") return crsmShowClaude;
      if (kind === "codex") return crsmShowCodex;
      if (kind === "claude-codex") return crsmShowClaudeCodex;
      // grok has no CRSM transcript support, the same exclusion CrsmPalette makes.
      return false;
    };
    return sessions
      .filter((s) => kindShown(s.kind))
      .filter((s) => !hideSessionsWithoutUserMessages || s.has_user_messages !== false)
      .map((s) => ({
        kind: "resume" as const,
        id: s.id,
        agentKind: s.kind,
        // The folder names the row; CRSM's label is the opening prompt again,
        // which the second line already carries.
        label: tailPath(s.cwd) || s.label,
        preview: previewLine(s.preview || s.label || ""),
        path: s.cwd,
        when: S.relativeWhen(s.last_activity),
        iconKind: s.kind === "claude-codex" ? "claude-codex" : s.kind,
      }));
  }, [
    showResume, sessions, crsmShowClaude, crsmShowCodex, crsmShowClaudeCodex,
    hideSessionsWithoutUserMessages,
  ]);

  const trimmed = query.trim();
  const matchedLaunch = useMemo(
    () => searchItems(allLaunch, trimmed),
    [allLaunch, trimmed],
  );
  const shownDev = useMemo(() => (showDev ? dev : []), [showDev, dev]);
  const shownAnken = useMemo(() => (showAnken ? anken : []), [showAnken, anken]);

  const matchedDirs = useMemo(
    () => searchItems([...shownDev, ...shownAnken], trimmed),
    [shownDev, shownAnken, trimmed],
  );
  const matchedResumes = useMemo(
    () => searchItems(resumes, trimmed),
    [resumes, trimmed],
  );

  /** Keyboard order (S12). Mirrors what the body renders, top to bottom. */
  const navigable: LauncherItem[] = useMemo(() => {
    if (trimmed) return [...matchedLaunch, ...matchedDirs, ...matchedResumes];
    const slice = <T,>(items: T[], key: string) =>
      expanded[key] ? items : items.slice(0, SECTION_PREVIEW);
    return [
      ...agents,
      ...webs,
      ...slice(shownDev, "dev"),
      ...slice(shownAnken, "anken"),
      ...slice(resumes, "resume"),
    ];
  }, [
    trimmed, matchedLaunch, matchedDirs, matchedResumes,
    agents, webs, shownDev, shownAnken, resumes, expanded,
  ]);

  useEffect(() => {
    setCursor(0);
  }, [trimmed]);

  // Twenty-odd entries do not fit 240px, so walking past the fold has to bring
  // the selection with it. `nearest` keeps the list still while the cursor is
  // already on screen.
  useEffect(() => {
    const node = paneRef.current?.querySelector(`[data-nav="${cursor}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const closeLauncherTab = useCallback(() => {
    removeTabFromPane(workspaceId, paneId, tabId);
  }, [removeTabFromPane, workspaceId, paneId, tabId]);

  const launchAgent = useCallback(
    (target: string, spec?: { model?: string; effort?: string }) => {
      // L1: never assemble the env by hand — sanitizeLaunchSpecValue lives in
      // here and is what stops `--model -x` reaching the CLI.
      const launchEnv = buildLaunchSpecEnv({ target, model: spec?.model, effort: spec?.effort });
      if (!launchEnv) return;
      const entry = getCatalogEntry(target);
      addTabToPaneWithOptions(workspaceId, paneId, {
        agentId: agentIdForSessionKind(entry?.agentKind) ?? "shell-starter",
        agentKind: entry?.agentKind,
        cwd: targetCwd,
        launchEnv,
      });
      closeLauncherTab();
    },
    [addTabToPaneWithOptions, workspaceId, paneId, targetCwd, closeLauncherTab],
  );

  const launchWeb = useCallback(
    (item: LauncherLaunchItem) => {
      // L3: web rows are a child webview, not a PTY, so they go the web route.
      addWebTabToPane(workspaceId, paneId, {
        presetId: item.target.replace(/^web-/, ""),
        label: item.short,
      });
      closeLauncherTab();
    },
    [addWebTabToPane, workspaceId, paneId, closeLauncherTab],
  );

  const launchResume = useCallback(
    (item: LauncherResumeItem) => {
      // Same env pair CrsmPalette sends (CrsmPalette.tsx:912): launcher.sh
      // resolves the session file, restores its cwd and picks the resume flags
      // per CLI, so none of that is rebuilt here.
      addTabToPaneWithOptions(workspaceId, paneId, {
        agentId: "shell-starter",
        label: item.label,
        labelSource: "ai",
        cwd: item.path,
        agentKind: item.agentKind,
        agentSessionId: item.id,
        launchEnv: { MYCMUX_RESUME: item.agentKind, MYCMUX_SESSION_ID: item.id },
      });
      closeLauncherTab();
    },
    [addTabToPaneWithOptions, workspaceId, paneId, closeLauncherTab],
  );

  const activate = useCallback(
    (item: LauncherItem) => {
      if (item.kind === "resume") {
        launchResume(item);
        return;
      }
      if (item.kind === "dir") {
        // Changing where a launch lands, not launching (§2.1 ordering).
        setTargetCwd(item.path);
        inputRef.current?.focus();
        return;
      }
      if (item.kind === "web") {
        launchWeb(item);
        return;
      }
      launchAgent(item.target);
    },
    [launchAgent, launchWeb, launchResume],
  );

  const openSpec = useCallback((target: string) => {
    setSpecTarget(target);
    setModel("");
    setEffort("");
  }, []);

  const onKeyDown = (event: React.KeyboardEvent | KeyboardEvent) => {
    // Left/right walk the list too, because the launch rows are pills laid out
    // across — but only while nothing is typed, or they would stop moving the
    // caret inside the query.
    const horizontal = query.length === 0;
    if (event.key === "ArrowDown" || (horizontal && event.key === "ArrowRight")) {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(navigable.length - 1, 0)));
    } else if (event.key === "ArrowUp" || (horizontal && event.key === "ArrowLeft")) {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter") {
      const item = navigable[cursor];
      if (item) {
        event.preventDefault();
        activate(item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (specTarget) setSpecTarget(null);
      else setQuery("");
    }
  };

  /**
   * Keys are taken at the document, not on this element.
   *
   * The pane that holds the app focus is the border div wrapping this one
   * (`DIV.terminal-pane-border` owns document.activeElement), and events land
   * on it — a handler down here is above the target and never sees them, which
   * is why the selection sat on the first chip no matter what was pressed.
   * Only the focused pane listens, and anything typed into a real input is left
   * alone.
   */
  // The handler closes over cursor and navigable, so it is replaced on every
  // render — but re-subscribing that often drops keys pressed while the
  // listener is being swapped (three arrow presses moved the cursor once).
  // The subscription is keyed on isActive alone and reads the current handler
  // through this ref.
  const keyHandlerRef = useRef(onKeyDown);
  keyHandlerRef.current = onKeyDown;

  useEffect(() => {
    if (!isActive) return undefined;
    const handler = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const typingElsewhere = active
        && active !== inputRef.current
        && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (typingElsewhere) return;
      keyHandlerRef.current(event);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isActive]);

  const chipFor = (item: LauncherLaunchItem, index: number) => {
    const entry = getCatalogEntry(item.target);
    const configurable = item.kind === "agent" && Boolean(entry);
    return (
      <span
        key={item.target}
        data-nav={index}
        style={{
          ...chipShell,
          // The ring alone is a 1px edge on a small pill; the fill is what makes
          // the keyboard position findable at a glance.
          ...(isActive && index === cursor
            ? { borderColor: "var(--cmux-accent)", background: "var(--cmux-selected)" }
            : null),
        }}
      >
        <button
          type="button"
          onMouseDown={keepFocus}
          title={item.label}
          onClick={() => activate(item)}
          style={{
            ...chipBody,
            paddingRight: configurable ? 4 : 9,
            ...(isActive && index === cursor ? { color: "var(--cmux-text)" } : null),
          }}
        >
          <AgentKindIcon kind={item.iconKind} size={17} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.short}
          </span>
        </button>
        {configurable && (
          // §6.3: model and effort must stay reachable — delegation routing
          // depends on picking a tier here. Left-click only (no context menu).
          <button
            type="button"
            onMouseDown={keepFocus}
            title={S.specTooltip(item.label)}
            aria-label={S.specTooltip(item.label)}
            onClick={() => {
              // Opening the spec is also a way of pointing at a row, so the
              // keyboard position follows the click instead of staying behind.
              setCursor(index);
              openSpec(item.target);
            }}
            style={{
              ...chipMore,
              ...(isActive && index === cursor ? { borderLeftColor: "var(--cmux-accent)" } : null),
            }}
          >
            ⋯
          </button>
        )}
      </span>
    );
  };

  const dirRow = (item: LauncherDirItem, index: number) => (
    <button
      type="button"
      onMouseDown={keepFocus}
      key={`${item.section}:${item.path}`}
      data-nav={index}
      title={item.path}
      onClick={() => activate(item)}
      style={{ ...row, ...(isActive && index === cursor ? rowSelected : null) }}
    >
      <FolderGlyph anken={item.section === "anken"} />
      <span style={primaryText}>{middleEllipsis(item.label, 26)}</span>
      {item.mark && <span style={markText}>{item.mark}</span>}
    </button>
  );

  const resumeRow = (item: LauncherResumeItem, index: number) => (
    <button
      type="button"
      onMouseDown={keepFocus}
      key={item.id}
      data-nav={index}
      title={`${item.label}\n${item.path}`}
      onClick={() => activate(item)}
      style={{
        ...row,
        ...(isActive && index === cursor ? rowSelected : null),
        alignItems: "flex-start",
      }}
    >
      <AgentKindIcon kind={item.iconKind} size={16} />
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>
        <span style={{ ...primaryText, display: "block" }}>{middleEllipsis(item.label, 22)}</span>
        {item.preview ? <span style={secondaryText}>{item.preview}</span> : null}
      </span>
      <span style={markText}>{item.when}</span>
    </button>
  );

  const heading = (title: string, total: number, key: string) => (
    <div style={sectionHeading}>
      <span>{title}</span>
      {total > SECTION_PREVIEW && (
        <button
          type="button"
          onMouseDown={keepFocus}
          style={moreButton}
          onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
        >
          {expanded[key] ? S.collapse : S.showAll(total)}
        </button>
      )}
    </div>
  );

  const specEntry = specTarget ? getCatalogEntry(specTarget) : undefined;
  const modelRejected = model.trim().length > 0 && !isValidLaunchSpecValue(model.trim());

  let offset = 0;
  const body: React.ReactNode[] = [];
  if (trimmed) {
    // S4: the section walls come down and the list becomes one crossing run.
    if (matchedLaunch.length > 0) {
      body.push(
        <div key="h-launch" style={sectionHeading}>
          <span>{S.launch}</span>
        </div>,
        <div key="launch" style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "3px 10px 6px" }}>
          {matchedLaunch.map((item, i) => chipFor(item, offset + i))}
        </div>,
      );
      offset += matchedLaunch.length;
    }
    if (matchedDirs.length + matchedResumes.length > 0) {
      body.push(
        <div key="flat" style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-accent)", padding: "6px 10px 2px", fontFamily: "var(--cmux-font-mono)" }}>
          {S.flatCount(matchedDirs.length + matchedResumes.length)}
        </div>,
        ...matchedDirs.map((item, i) => dirRow(item, offset + i)),
      );
      offset += matchedDirs.length;
      body.push(...matchedResumes.map((item, i) => resumeRow(item, offset + i)));
      offset += matchedResumes.length;
    }
    if (body.length === 0) {
      body.push(
        <div key="empty" style={{ padding: "18px 12px", fontSize: 11, color: "var(--cmux-text-tertiary)", textAlign: "center" }}>
          {S.noMatch(trimmed)}
        </div>,
      );
    }
  } else {
    body.push(
      <div key="h-agents" style={sectionHeading}><span>{S.launch}</span></div>,
      <div key="agents" style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "3px 10px 6px" }}>
        {agents.map((item, i) => chipFor(item, offset + i))}
      </div>,
    );
    offset += agents.length;
    body.push(
      <div key="h-web" style={sectionHeading}><span>{S.web}</span></div>,
      <div key="web" style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "3px 10px 6px" }}>
        {webs.map((item, i) => chipFor(item, offset + i))}
      </div>,
    );
    offset += webs.length;
    if (showDev) {
      const devShown = expanded.dev ? shownDev : shownDev.slice(0, SECTION_PREVIEW);
      body.push(
        <div key="h-dev">{heading(S.dev, shownDev.length, "dev")}</div>,
        ...devShown.map((item, i) => dirRow(item, offset + i)),
      );
      offset += devShown.length;
    }
    if (showAnken) {
      const ankenShown = expanded.anken ? shownAnken : shownAnken.slice(0, SECTION_PREVIEW);
      body.push(
        <div key="h-anken">{heading(S.anken, shownAnken.length, "anken")}</div>,
        ...ankenShown.map((item, i) => dirRow(item, offset + i)),
      );
      offset += ankenShown.length;
    }
    if (showResume) {
      const resumeShown = expanded.resume ? resumes : resumes.slice(0, SECTION_PREVIEW);
      // "すべて" expands to what was fetched (RESUME_FETCH_LIMIT). Past that,
      // Ctrl+P is the tool — it pages through thousands, and this list is
      // deliberately a shortcut to the recent few.
      body.push(
        <div key="h-resume">{heading(S.resume, resumes.length, "resume")}</div>,
        ...resumeShown.map((item, i) => resumeRow(item, offset + i)),
      );
      offset += resumeShown.length;
      if (resumes.length === 0) {
        body.push(
          <div key="resume-empty" style={{ padding: "6px 12px", fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-tertiary)" }}>
            {S.resumeEmpty}
          </div>,
        );
      }
    }
  }

  return (
    <div
      ref={paneRef}
      data-launcher-pane="true"
      // No onKeyDown here: the document listener above already has it, and both
      // would fire for anything typed into the search box, moving the cursor
      // two at a time.
      //
      // Bubbles up from the chips: each one suppresses the default to keep the
      // caret, and the pane still learns it was clicked.
      onMouseDown={claimFocus}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--cmux-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          padding: 8,
          borderBottom: "1px solid var(--cmux-border-hairline)",
          display: "flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flex: "0 0 auto", opacity: 0.45 }} aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={S.searchPlaceholder}
          aria-label={S.searchPlaceholder}
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            background: "transparent",
            border: 0,
            outline: 0,
            color: "var(--cmux-text)",
            fontSize: "var(--cmux-font-size-sm)",
            padding: "3px 0",
          }}
        />
      </div>

      {specEntry && (
        <div
          data-launcher-spec="true"
          style={{
            flex: "0 0 auto",
            padding: "8px 10px",
            borderBottom: "1px solid var(--cmux-border-hairline)",
            display: "flex",
            flexDirection: "column",
            gap: 5,
            background: "var(--cmux-popover)",
          }}
        >
          <div style={{ fontSize: "var(--cmux-font-size-xs)", color: "var(--cmux-text-secondary)" }}>
            {specEntry.label}
          </div>
          <div style={specLabel}>{S.modelLabel}</div>
          {specEntry.models.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <button
                type="button"
                onMouseDown={keepFocus}
                onClick={() => setModel("")}
                style={{ ...specChip, ...(model === "" ? specChipOn : null) }}
              >
                {S.specDefault}
              </button>
              {specEntry.models.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  onMouseDown={keepFocus}
                  title={choice.value}
                  onClick={() => setModel(choice.value)}
                  style={{ ...specChip, ...(model === choice.value ? specChipOn : null) }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          ) : (
            // grok and the open-model backend publish no id list, so the value
            // is typed. sanitizeLaunchSpecValue still guards what reaches the CLI.
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={S.modelDefault}
              aria-label={S.modelLabel}
              spellCheck={false}
              style={{ ...specControl, borderColor: modelRejected ? "var(--cmux-red)" : "var(--cmux-border)" }}
            />
          )}
          {specEntry.efforts.length > 0 && (
            <>
              <div style={specLabel}>{S.effortLabel}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <button
                  type="button"
                  onMouseDown={keepFocus}
                  onClick={() => setEffort("")}
                  style={{ ...specChip, ...(effort === "" ? specChipOn : null) }}
                >
                  {S.specDefault}
                </button>
                {specEntry.efforts.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onMouseDown={keepFocus}
                    onClick={() => setEffort(value)}
                    style={{ ...specChip, ...(effort === value ? specChipOn : null) }}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </>
          )}
          <div style={{ display: "flex", gap: 5 }}>
            <button
              type="button"
              onMouseDown={keepFocus}
              onClick={() => launchAgent(specEntry.target, { model, effort })}
              style={{ ...specControl, cursor: "pointer", borderColor: "var(--cmux-accent)", color: "var(--cmux-accent)", width: "auto", flex: 1 }}
            >
              {S.launchButton}
            </button>
            <button
              type="button"
              onMouseDown={keepFocus}
              onClick={() => setSpecTarget(null)}
              style={{ ...specControl, cursor: "pointer", width: "auto", flex: "0 0 auto", color: "var(--cmux-text-tertiary)" }}
            >
              {S.cancel}
            </button>
          </div>
        </div>
      )}

      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "2px 0 10px" }}>{body}</div>

      <div
        style={{
          flex: "0 0 auto",
          borderTop: "1px solid var(--cmux-border-hairline)",
          padding: "6px 10px",
          fontSize: "var(--cmux-font-size-xs)",
          color: "var(--cmux-text-dim)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <FolderGlyph anken={false} />
        <span
          title={targetCwd ?? ""}
          style={{
            fontFamily: "var(--cmux-font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--cmux-text-secondary)",
          }}
        >
          {targetCwd ? middleEllipsis(targetCwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/"), 24) : S.cwdUnset}
        </span>
        {/* S11: the footer is also where the launch directory is changed. It
            clears the query and opens both directory sections, because that is
            where the choices are. */}
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={() => {
            setQuery("");
            setExpanded((prev) => ({ ...prev, dev: true, anken: true }));
            inputRef.current?.focus();
          }}
          style={{ ...moreButton, marginLeft: "auto", flex: "0 0 auto" }}
          title={S.changeCwdTooltip}
        >
          {S.changeCwd}
        </button>
      </div>
    </div>
  );
}
