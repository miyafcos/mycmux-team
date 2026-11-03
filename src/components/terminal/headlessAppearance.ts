import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { shouldAdaptLightColorsForPane } from "../../lib/lightDarkColorAdapt";
import { buildTerminalPaneLaunch } from "../../lib/terminalPaneLaunch";
import { readLiveTerminalAppearance } from "../../stores/compositionStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { liveTerms, termCache } from "./terminalCache";
import { withAnsiContrastFloor } from "./terminalThemeColors";

export interface HeadlessAppearance {
  theme: ITheme;
  windowsPty: ITerminalOptions["windowsPty"];
  light: boolean;
  adaptColors: boolean;
}

/** Same launch resolution, process-title policy and theme correction as live. */
export function readHeadlessAppearance(sessionId: string): HeadlessAppearance {
  let command = "";
  for (const workspace of useWorkspaceListStore.getState().workspaces) {
    for (const pane of workspace.panes) {
      const tab = pane.tabs.find(candidate => candidate.sessionId === sessionId);
      if (tab) command = buildTerminalPaneLaunch(pane, tab, { getAgent, getDefaultAgent }).launchCommand;
    }
  }
  const theme = useThemeStore.getState().theme;
  const appearance = readLiveTerminalAppearance();
  const terminal = liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term;
  return {
    theme: terminal?.options.theme ?? withAnsiContrastFloor(theme.terminal, appearance.mediaActive),
    windowsPty: terminal?.options.windowsPty,
    light: theme.colorScheme === "light",
    adaptColors: shouldAdaptLightColorsForPane(command,
      usePaneMetadataStore.getState().volatileMetadata[sessionId]?.processTitle,
      useSettingsStore.getState().colorAdaptCommands),
  };
}

/** Keep a scrolled PC viewport when its parser is temporarily behind the PTY. */
export function headlessScreenViewport(sessionId: string, baseY: number): number | undefined {
  const terminal = liveTerms.get(sessionId) ?? termCache.get(sessionId)?.term;
  if (!terminal) return undefined;
  const buffer = terminal.buffer.active;
  return Math.max(0, baseY - (buffer.baseY - buffer.viewportY));
}
