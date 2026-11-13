import { TextDecoder, TextEncoder } from "node:util";
import { describe, expect, it } from "vitest";
import { tidyToolOutput } from "../../src/lib/toolOutputTidy";

const decode = (bytes: Uint8Array | number[]) => new TextDecoder("utf-8").decode(new Uint8Array(bytes));
const fromHex = (hex: string) => decode(Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16)));
const bytes = new TextEncoder().encode("ダッシュボード");
const R = decode([0x83]);
const tails = [decode(bytes.slice(0, -1)), decode(bytes.slice(0, -2))];
const heads = [decode(bytes.slice(1)), decode(bytes.slice(2))];
const both = [decode(bytes.slice(1, -1)), decode(bytes.slice(2, -2))];
const unreadable = [
  "3132372e302e302e312082c92070696e672082f09197904d82b582c482a282dc82b720333220836f8343836782cc8366815b835e3a",
  "8fee95f13a208e7792e882b382ea82bd8ff08c8f82c988ea927682b782e9835e8358834e82cd8ec08d7382b382ea82c482a282dc82b982f18142",
  "32303236944e31318c8e3993fa20373a34383a3138",
].map(fromHex);
const interior = [`ab${R}cd`, `ab${R}${R}cd`, `ab${R}cd${R}ef`];
const continuations = [`abc${R}\ndef`, `abc${R}\r\ndef`];
const mixed = `${unreadable[0]}\r\n${tails[0]}\nordinary\n${unreadable[1]}\r\n`;
const allReplacement = [1, 2, 3, 4, 5, 8].map(count => R.repeat(count));
const longEdges = [`abc${R.repeat(4)}`, `${R.repeat(4)}abc`, `${R.repeat(4)}abc${R}`];

describe("tool output display tidying", () => {
  it.each(["日本語と English 😀", "", "\n", "\n\n", "一行\r\n二行\r\n", " \t\r\n"])(
    "T-1 preserves replacement-free text %j",
    text => expect(tidyToolOutput(text)).toEqual({ text, lossy: false }),
  );

  it.each(tails)("T-2 tidies a cut final UTF-8 character: %j", text => {
    expect(tidyToolOutput(text)).toEqual({ text: "ダッシュボー…", lossy: false });
  });
  it.each(continuations)("T-2 preserves the exact line ending and following line: %j", text => {
    expect(tidyToolOutput(text)).toEqual({ text: text.replace(R, "…"), lossy: false });
  });

  it.each(heads)("T-3 tidies a cut first UTF-8 character: %j", text => {
    expect(tidyToolOutput(text)).toEqual({ text: "…ッシュボード", lossy: false });
  });
  it.each(both)("T-3 tidies cuts at both ends: %j", text => {
    expect(tidyToolOutput(text)).toEqual({ text: "…ッシュボー…", lossy: false });
  });

  it.each(interior)("T-4 preserves one or two interior replacements: %j", text => {
    expect(tidyToolOutput(text)).toEqual({ text, lossy: true });
  });

  it.each(unreadable)("T-5 flags a recorded cp932 line without changing it: %j", text => {
    expect(tidyToolOutput(text)).toEqual({ text, lossy: true });
  });

  it("T-6 tidies only cut lines in mixed output", () => {
    const result = tidyToolOutput(mixed);
    expect(result).toEqual({
      text: `${unreadable[0]}\r\nダッシュボー…\nordinary\n${unreadable[1]}\r\n`,
      lossy: true,
    });
    expect(result.text.split("\n")).toHaveLength(mixed.split("\n").length);
  });

  it.each(allReplacement)("T-7 handles a replacement-only line: %j", text => {
    expect(tidyToolOutput(text)).toEqual(text.length === 1
      ? { text: "…", lossy: false }
      : { text, lossy: true });
    expect(tidyToolOutput(text + "\r\n")).toEqual(text.length === 1
      ? { text: "…\r\n", lossy: false }
      : { text: text + "\r\n", lossy: true });
  });

  it.each([1, 2, 3])("C1b-B15 flags a short damaged final character run of %i", count => {
    const text = `OK ${R.repeat(count + 1)}`;
    expect(tidyToolOutput(text)).toEqual({ text, lossy: true });
  });

  it.each(longEdges)("T-8 preserves an edge run longer than three: %j", text => {
    expect(tidyToolOutput(text)).toEqual({ text, lossy: true });
  });

  it("A-4/A-7 preserves spaces, carriage returns, other characters and NUL", () => {
    expect(tidyToolOutput(`\0😀\t${tails[0]}\r\n`)).toEqual({ text: "\0😀\tダッシュボー…\r\n", lossy: false });
    for (const text of [` ${R} `, `\t${R}\t`, `a\0${R}b`, `abc${R}\r\r\n`]) {
      expect(tidyToolOutput(text)).toEqual({ text, lossy: true });
    }
    const text = `a${R}b${R}c${R}d\0`;
    expect(tidyToolOutput(text)).toEqual({ text, lossy: true });
  });

  it.each([...tails, ...heads, ...both, ...continuations, ...interior, ...unreadable, mixed,
    ...allReplacement.flatMap(text => [text, text + "\r\n"]), ...longEdges])(
    "T-9 is idempotent for every T-2 through T-8 fixture: %j",
    text => {
      const once = tidyToolOutput(text);
      expect(tidyToolOutput(once.text)).toEqual(once);
    },
  );
});
