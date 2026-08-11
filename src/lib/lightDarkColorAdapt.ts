type Rgb = readonly [number, number, number];

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHsl([red, green, blue]: Rgb): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  return [((hue * 60) + 360) % 360, saturation, lightness];
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hueSegment = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hueSegment < 1) [r, g] = [chroma, secondary];
  else if (hueSegment < 2) [r, g] = [secondary, chroma];
  else if (hueSegment < 3) [g, b] = [chroma, secondary];
  else if (hueSegment < 4) [g, b] = [secondary, chroma];
  else if (hueSegment < 5) [r, b] = [secondary, chroma];
  else [r, b] = [chroma, secondary];
  const match = lightness - chroma / 2;
  return [
    clampChannel((r + match) * 255),
    clampChannel((g + match) * 255),
    clampChannel((b + match) * 255),
  ];
}

function invertLightness(rgb: Rgb): Rgb {
  const [hue, saturation, lightness] = rgbToHsl(rgb);
  return hslToRgb(hue, saturation, 1 - lightness);
}

function cubeIndexToRgb(index: number): Rgb {
  const offset = index - 16;
  return [
    Math.floor(offset / 36) * 51,
    Math.floor((offset % 36) / 6) * 51,
    (offset % 6) * 51,
  ];
}

function isByte(value: string | undefined): boolean {
  if (value === undefined || !/^\d+$/.test(value)) return false;
  const numeric = Number(value);
  return numeric >= 0 && numeric <= 255;
}

function transformSgrParameters(parameters: string): string {
  const values = parameters === "" ? [""] : parameters.split(";");
  let changed = false;
  for (let index = 0; index < values.length; index += 1) {
    const mode = values[index];
    if ((mode !== "38" && mode !== "48") || index + 1 >= values.length) continue;
    const type = values[index + 1];
    if (type === "2" && index + 4 < values.length
      && isByte(values[index + 2]) && isByte(values[index + 3]) && isByte(values[index + 4])) {
      const inverted = invertLightness([
        Number(values[index + 2]),
        Number(values[index + 3]),
        Number(values[index + 4]),
      ]);
      values.splice(index + 2, 3, ...inverted.map(String));
      changed = true;
      index += 4;
    } else if (type === "5" && index + 2 < values.length && isByte(values[index + 2])) {
      const paletteIndex = Number(values[index + 2]);
      if (paletteIndex >= 16 && paletteIndex <= 231) {
        const inverted = invertLightness(cubeIndexToRgb(paletteIndex));
        values.splice(index + 1, 2, "2", ...inverted.map(String));
        changed = true;
        index += 4;
      } else if (paletteIndex >= 232) {
        values[index + 2] = String(255 + 232 - paletteIndex);
        changed = true;
        index += 2;
      } else {
        index += 2;
      }
    }
  }
  return changed ? values.join(";") : parameters;
}

/** Converts light hard-coded SGR colors immediately before xterm rendering. */
export class LightDarkColorAdapt {
  private pending = "";

  reset(): void {
    this.pending = "";
  }

  transform(chunk: string): string {
    const input = this.pending + chunk;
    this.pending = "";
    let output = "";
    let cursor = 0;
    while (cursor < input.length) {
      const escape = input.indexOf("\u001b", cursor);
      if (escape === -1) return output + input.slice(cursor);
      output += input.slice(cursor, escape);
      if (escape + 1 === input.length) {
        this.pending = input.slice(escape);
        return output;
      }
      if (input[escape + 1] !== "[") {
        const controlType = input[escape + 1];
        if (controlType === "]") {
          let end = escape + 2;
          while (end < input.length) {
            if (input.charCodeAt(end) === 0x07) break;
            if (input[end] === "\u001b" && input[end + 1] === "\\") {
              end += 1;
              break;
            }
            end += 1;
          }
          if (end === input.length) {
            this.pending = input.slice(escape);
            return output;
          }
          output += input.slice(escape, end + 1);
          cursor = end + 1;
          continue;
        }
        if (controlType === "P" || controlType === "X" || controlType === "^" || controlType === "_") {
          const terminator = input.indexOf("\u001b\\", escape + 2);
          if (terminator === -1) {
            this.pending = input.slice(escape);
            return output;
          }
          output += input.slice(escape, terminator + 2);
          cursor = terminator + 2;
          continue;
        }
        output += input.slice(escape, escape + 2);
        cursor = escape + 2;
        continue;
      }

      let end = escape + 2;
      while (end < input.length) {
        const code = input.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end === input.length) {
        this.pending = input.slice(escape);
        return output;
      }
      const final = input[end];
      const parameters = input.slice(escape + 2, end);
      output += final === "m"
        ? `\u001b[${transformSgrParameters(parameters)}m`
        : input.slice(escape, end + 1);
      cursor = end + 1;
    }
    return output;
  }
}

function normalizeCommandName(command: string): string {
  const leaf = command.trim().split(/[\\/]/).pop() ?? "";
  return leaf.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

export function shouldAdaptLightColors(command: string, configuredCommands: readonly string[]): boolean {
  const normalizedCommand = normalizeCommandName(command);
  if (!normalizedCommand) return false;
  return configuredCommands.some((configured) => normalizeCommandName(configured) === normalizedCommand);
}

export function shouldAdaptLightColorsForPane(
  command: string,
  processTitle: string | undefined,
  configuredCommands: readonly string[],
): boolean {
  return shouldAdaptLightColors(command, configuredCommands)
    || shouldAdaptLightColors(processTitle ?? "", configuredCommands);
}

/** Keeps a streaming adapter stateful while command eligibility changes. */
export class LightDarkColorAdaptController {
  private enabled = false;

  private readonly adapter = new LightDarkColorAdapt();

  transform(chunk: string, enabled: boolean): string {
    if (this.enabled && !enabled) {
      this.adapter.reset();
    }
    this.enabled = enabled;
    return enabled ? this.adapter.transform(chunk) : chunk;
  }

  reset(): void {
    this.adapter.reset();
  }
}
