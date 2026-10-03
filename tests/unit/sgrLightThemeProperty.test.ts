import { describe, expect, it } from "vitest";
import { SgrLightRewriter } from "../../src/components/terminal/sgrLightTheme";

// The frozen pre-change streaming implementation is the property oracle.
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

function rewriteSgrForLightTheme(
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
class LegacySgrLightRewriter {
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

describe("SGR streaming equivalence", () => {
  it("matches the old implementation across arbitrary theme switches, control strings and chunk boundaries", () => {
    const atoms = ["plain", "\x1b", "[", "2", "22", ";", ":", "m", "]", "P", "X", "^", "_", "\\", "\x07", "\r", "\n", "\x00", "\x1b[2m", "\x1b[22m", "\x1b]title", "\x1bPpayload", "\x1b\\", "\x1b[38;2;2;22;3m", "\x1b[" + "2;".repeat(40)];
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let run = 0; run < 200; run++) {
      const current = new SgrLightRewriter(); const old = new LegacySgrLightRewriter();
      for (let step = 0; step < 100; step++) {
        const chunk = Array.from({ length: random() % 6 }, () => atoms[random() % atoms.length]).join("");
        const light = random() % 3 === 0;
        expect(current.transform(chunk, light)).toBe(old.transform(chunk, light));
        if (random() % 20 === 0) { current.reset(); old.reset(); }
      }
      expect(current.flushPending()).toBe(old.flushPending());
    }
  });
  it("returns a large dark chunk unchanged while retaining control-string state for light mode", () => {
    const current = new SgrLightRewriter();
    const chunk = "ordinary output\n".repeat(100_000) + "\x1b]title";
    expect(current.transform(chunk, false)).toBe(chunk);
    expect(current.transform("\x1b[2m\x07\x1b[2m", true)).toBe("\x1b[2m\x07\x1b[90m");
  });
});
