export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type ThemeGroup = "calm-dark" | "vivid-dark" | "light";
export type ThemeColorScheme = "dark" | "light";

export interface ThemeStatusColors {
  working: string;
  waiting: string;
  done: string;
  error: string;
}

export type ThemeTweakColorKey =
  | "chrome.background"
  | "chrome.surface"
  | "chrome.border"
  | "chrome.text"
  | "chrome.textMuted"
  | "chrome.textDim"
  | "chrome.accent"
  | "chrome.hover"
  | "chrome.selected"
  | "chrome.danger"
  | "terminal.background"
  | "terminal.foreground"
  | "terminal.cursor"
  | "terminal.selectionBackground"
  | "terminal.black"
  | "terminal.red"
  | "terminal.green"
  | "terminal.yellow"
  | "terminal.blue"
  | "terminal.magenta"
  | "terminal.cyan"
  | "terminal.white"
  | "terminal.brightBlack"
  | "terminal.brightRed"
  | "terminal.brightGreen"
  | "terminal.brightYellow"
  | "terminal.brightBlue"
  | "terminal.brightMagenta"
  | "terminal.brightCyan"
  | "terminal.brightWhite"
  | "status.working"
  | "status.waiting"
  | "status.done"
  | "status.error"
  | "notification";

export interface ThemeTweaks {
  enabled: boolean;
  colors: Partial<Record<ThemeTweakColorKey, string>>;
  background: ThemeBackgroundSettings;
}

export type ThemeBackgroundMode = "solid" | "preset" | "image";

export interface ThemeBackgroundSettings {
  mode: ThemeBackgroundMode;
  presetId: string;
  imagePath: string;
  imageOpacity: number;
  imageBlur: number;
  imageDim: number;
  panelOpacity: number;
  terminalOpacity: number;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  group: ThemeGroup;
  description: string;
  colorScheme: ThemeColorScheme;
  terminal: TerminalColors;
  chrome: {
    background: string;
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    textDim: string;
    accent: string;
    hover: string;
    selected: string;
    danger: string;
  };
  status: ThemeStatusColors;
  notification: string;
}
