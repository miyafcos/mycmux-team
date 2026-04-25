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
