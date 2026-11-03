import type { ITheme, Terminal } from "@xterm/xterm";
import { terminalScreenTheme, type ScreenTheme } from "./terminalScreenSnapshot";
import { ptyReadGeneration, type PtyReadGeneration } from "../../lib/ptyReadGeneration";

type ObservableTerminal = Pick<Terminal, "parser" | "loadAddon">;
interface ScreenState {
  cursorVisible: boolean;
  themeKey: string;
  colors: Map<number, string>;
  readTheme: () => ITheme | undefined;
  sessionId?: string;
  themeRevision: number;
}
const states = new WeakMap<ObservableTerminal, ScreenState>();
const themeRevisions = new WeakMap<PtyReadGeneration, number>();
const specialColors = ["foreground", "background", "cursor"] as const;

function syncTheme(state: ScreenState, theme: ScreenTheme): void {
  const key = JSON.stringify(theme);
  const revision = state.sessionId ? themeRevisions.get(ptyReadGeneration(state.sessionId)) ?? 0 : 0;
  if (state.themeKey !== key || state.themeRevision !== revision) {
    state.themeKey = key; state.themeRevision = revision; state.colors.clear();
  }
}

export function resetTerminalScreenState(terminal: ObservableTerminal): void {
  const state = states.get(terminal);
  if (state) state.cursorVisible = true;
}

export function terminalScreenCursorVisible(terminal: ObservableTerminal): boolean {
  return states.get(terminal)?.cursorVisible ?? true;
}

export function terminalScreenThemeFor(terminal: ObservableTerminal, base: ITheme = {}): ScreenTheme {
  const theme = terminalScreenTheme(base), state = states.get(terminal);
  if (!state) return theme;
  syncTheme(state, theme);
  for (const [index, color] of state.colors) {
    if (index < 16) theme.palette[index] = color;
    else if (index >= 256) theme[specialColors[index - 256]] = color;
  }
  return theme;
}

export function terminalScreenPaletteOverrides(terminal: ObservableTerminal): ReadonlyMap<number, string> | undefined {
  return states.get(terminal)?.colors;
}

/** Called wherever live xterm receives options.theme, which resets OSC colors. */
export function resetTerminalScreenColors(terminal: ObservableTerminal): void {
  const state = states.get(terminal);
  if (state?.sessionId) {
    const generation = ptyReadGeneration(state.sessionId);
    themeRevisions.set(generation, (themeRevisions.get(generation) ?? 0) + 1);
  }
  state?.colors.clear();
}

/** Match xterm 6's XParseColor syntax, including its #RGB high-nibble rule. */
function oscRgb(value: string): string | undefined {
  let channels: number[];
  const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(value);
  if (rgb && rgb[1].length === rgb[2].length && rgb[1].length === rgb[3].length) {
    channels = rgb.slice(1).map(c => Math.round(parseInt(c, 16) * 255 / (16 ** c.length - 1)));
  } else if (/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{9}|[\da-f]{12})$/i.test(value)) {
    const width = (value.length - 1) / 3;
    channels = [0, 1, 2].map(i => {
      const c = parseInt(value.slice(1 + i * width, 1 + (i + 1) * width), 16);
      return width === 1 ? c << 4 : c >> ((width - 2) * 4);
    });
  } else return undefined;
  return "#" + channels.map(c => c.toString(16).padStart(2, "0")).join("");
}

/** Observe public parser events without consuming them or reading private core
 * state. Besides DECTCEM, OSC colors can change the applied theme behind options.
 */
export function trackTerminalScreenState(terminal: ObservableTerminal, readTheme: () => ITheme | undefined = () => ({}), sessionId?: string): void {
  if (states.has(terminal)) return;
  const state: ScreenState = { cursorVisible: true, themeKey: "", colors: new Map(), readTheme, sessionId, themeRevision: 0 };
  syncTheme(state, terminalScreenTheme(readTheme())); states.set(terminal, state);
  const colorHandler = (id: number, observe: (data: string) => void) => terminal.parser.registerOscHandler(id, data => {
    syncTheme(state, terminalScreenTheme(state.readTheme())); observe(data); return false;
  });
  const handlers = [
    ...(["h", "l"] as const).map(final => terminal.parser.registerCsiHandler({ prefix: "?", final }, params => {
      if (params.includes(25)) state.cursorVisible = final === "h";
      return false;
    })),
    terminal.parser.registerEscHandler({ final: "c" }, () => { resetTerminalScreenState(terminal); return false; }),
    terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => { resetTerminalScreenState(terminal); return false; }),
    colorHandler(4, data => {
      const parts = data.split(";");
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const index = /^\d+$/.test(parts[i]) ? Number(parts[i]) : -1, color = oscRgb(parts[i + 1]);
        if (index >= 0 && index < 256 && color) state.colors.set(index, color);
      }
    }),
    colorHandler(104, data => {
      if (!data) {
        for (let i = 0; i < 256; i++) state.colors.delete(i);
      } else {
        for (const index of data.split(";")) if (/^\d+$/.test(index) && Number(index) < 256) state.colors.delete(Number(index));
      }
    }),
    ...[10, 11, 12].map(id => colorHandler(id, data => {
      const colors = data.split(";");
      for (let i = 0; i < colors.length && id + i <= 12; i++) {
        const color = oscRgb(colors[i]); if (color) state.colors.set(256 + id - 10 + i, color);
      }
    })),
    ...[110, 111, 112].map(id => colorHandler(id, () => { state.colors.delete(256 + id - 110); })),
  ];
  terminal.loadAddon({ activate() {}, dispose() { handlers.forEach(handler => handler.dispose()); states.delete(terminal); } });
}
