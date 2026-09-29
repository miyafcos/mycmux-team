/** Plan replacements without treating extended-color payloads as SGR commands. */
function replacements(params: number[], hasSubParams: (index: number) => boolean): number[][] {
  const result = params.map(value => [value]);
  for (let i = 0; i < params.length; i += 1) {
    if (hasSubParams(i)) continue;
    const value = params[i];
    if (value === 38 || value === 48 || value === 58) {
      if (params[i + 1] === 5) i += 2;
      else if (params[i + 1] === 2) i += 4;
    } else if (value === 2) {
      result[i] = [90];
    } else if (value === 22) {
      result[i] = [22, 39];
    }
  }
  return result;
}

export function rewriteSgrForLightTheme(
  params: number[],
  hasSubParams: (index: number) => boolean,
): number[] {
  return replacements(params, hasSubParams).flat();
}

function rewriteSequence(sequence: string): string {
  const body = sequence.slice(2, -1);
  if (!/^[\d;:]*$/.test(body)) return sequence;
  const tokens = body.split(";");
  const values = tokens.map(token => Number(token.split(":", 1)[0]));
  const rewritten = replacements(values, i => tokens[i].includes(":"));
  return `\x1b[${rewritten.map((part, i) => (
    part.length === 1 && part[0] === values[i] ? tokens[i] : part.join(";")
  )).join(";")}m`;
}

/** Streaming SGR-only filter. Control strings and non-SGR CSI pass through. */
export class SgrLightRewriter {
  private pending = "";
  private controlString: "osc" | "st" | null = null;
  private stringEscape = false;

  reset(): void {
    this.pending = "";
    this.controlString = null;
    this.stringEscape = false;
  }

  /** Release an incomplete sequence unchanged when switching to a dark theme. */
  flushPending(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }

  transform(chunk: string, light: boolean): string {
    return light ? this.push(chunk) : this.scan(this.flushPending() + chunk, false);
  }

  push(chunk: string): string {
    return this.scan(chunk, true);
  }

  private scan(chunk: string, rewrite: boolean): string {
    const input = this.pending + chunk;
    this.pending = "";
    let output = "";
    for (let i = 0; i < input.length;) {
      const char = input[i];
      if (this.controlString) {
        output += char;
        if ((this.controlString === "osc" && char === "\x07")
          || (this.stringEscape && char === "\\")) this.controlString = null;
        this.stringEscape = char === "\x1b";
        i += 1;
        continue;
      }
      if (char !== "\x1b") {
        output += char;
        i += 1;
        continue;
      }
      if (i + 1 === input.length) {
        if (rewrite) this.pending = char;
        else output += char;
        break;
      }
      const next = input[i + 1];
      if (next !== "[") {
        if (next === "]") this.controlString = "osc";
        else if ("PX^_".includes(next)) this.controlString = "st";
        this.stringEscape = false;
        output += input.slice(i, i + 2);
        i += 2;
        continue;
      }
      let end = i + 2;
      while (end < input.length && /[\x20-\x3f]/.test(input[end])) end += 1;
      if (end === input.length) {
        const tail = input.slice(i);
        if (rewrite && tail.length <= 64) this.pending = tail;
        else output += tail;
        break;
      }
      // An unexpected control byte cancels this candidate; process it normally.
      if (!/[\x40-\x7e]/.test(input[end])) {
        output += input.slice(i, end);
        i = end;
        continue;
      }
      const sequence = input.slice(i, end + 1);
      output += rewrite && input[end] === "m" ? rewriteSequence(sequence) : sequence;
      i = end + 1;
    }
    return output;
  }
}
