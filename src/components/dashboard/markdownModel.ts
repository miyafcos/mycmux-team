export type MdInline =
  | { type: "text"; text: string }
  | { type: "bold"; children: MdInline[] }
  | { type: "italic"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "link"; label: MdInline[]; url: string };

export type MdTableAlign = "left" | "center" | "right" | null;

export interface MdListItem {
  inline: MdInline[];
  checked: boolean | null;
  children: MdListBlock[];
}

export interface MdListBlock {
  type: "list";
  ordered: boolean;
  items: MdListItem[];
}

export type MdBlock =
  | { type: "heading"; level: number; inline: MdInline[] }
  | { type: "paragraph"; inline: MdInline[] }
  | MdListBlock
  | { type: "code"; lang: string | null; text: string }
  | { type: "quote"; inline: MdInline[] }
  | { type: "hr" }
  | {
    type: "table";
    header: MdInline[][];
    rows: MdInline[][][];
    align: MdTableAlign[];
    numeric: boolean[];
  };

function appendText(parts: MdInline[], text: string) {
  if (!text) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "text") previous.text += text;
  else parts.push({ type: "text", text });
}

/** A deliberately small, lossless Markdown subset for live agent messages. */
export function parseInline(text: string): MdInline[] {
  const parts: MdInline[] = [];
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end !== -1) {
        parts.push({ type: "bold", children: parseInline(text.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end !== -1) {
        parts.push({ type: "code", text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (text[index] === "[") {
      const labelEnd = text.indexOf("](", index + 1);
      const urlEnd = labelEnd === -1 ? -1 : text.indexOf(")", labelEnd + 2);
      if (labelEnd !== -1 && urlEnd !== -1) {
        parts.push({
          type: "link",
          label: parseInline(text.slice(index + 1, labelEnd)),
          url: text.slice(labelEnd + 2, urlEnd),
        });
        index = urlEnd + 1;
        continue;
      }
    }
    if (text[index] === "*") {
      const end = text.indexOf("*", index + 1);
      if (end !== -1) {
        parts.push({ type: "italic", children: parseInline(text.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
    }
    appendText(parts, text[index]);
    index += 1;
  }
  return parts;
}

function listMatch(line: string): { indent: number; ordered: boolean; text: string } | null {
  const match = /^([ \t]*)(?:([-+*])|(\d+)[.)])\s+(.*)$/u.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/gu, "  ").length,
    ordered: Boolean(match[3]),
    text: match[4],
  };
}

function parseChecklist(text: string): { checked: boolean | null; text: string } {
  const match = /^\[([ xX])\]\s*(.*)$/u.exec(text);
  if (!match) return { checked: null, text };
  return { checked: match[1].toLowerCase() === "x", text: match[2] };
}

function parseList(lines: readonly string[], start: number, indent: number, ordered: boolean): { block: MdListBlock; next: number } {
  const items: MdListItem[] = [];
  let index = start;

  while (index < lines.length) {
    const item = listMatch(lines[index]);
    if (!item || item.indent < indent || (item.indent === indent && item.ordered !== ordered)) break;

    if (item.indent > indent) {
      const parent = items[items.length - 1];
      if (!parent) break;
      const nested = parseList(lines, index, item.indent, item.ordered);
      parent.children.push(nested.block);
      index = nested.next;
      continue;
    }

    const checklist = parseChecklist(item.text);
    items.push({
      inline: parseInline(checklist.text),
      checked: checklist.checked,
      children: [],
    });
    index += 1;
  }

  return { block: { type: "list", ordered, items }, next: index };
}

function isHorizontalRule(line: string): boolean {
  return /^\s*-{3,}\s*$/u.test(line);
}

function splitTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  let inCode = false;
  let start = trimmed.startsWith("|") ? 1 : 0;
  const end = trimmed.endsWith("|") ? trimmed.length - 1 : trimmed.length;

  for (; start < end; start += 1) {
    const char = trimmed[start];
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      inCode = !inCode;
      cell += char;
      continue;
    }
    if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function parseTableAlignments(cells: readonly string[]): MdTableAlign[] | null {
  const alignments: MdTableAlign[] = [];
  for (const cell of cells) {
    const match = /^(:)?-{2,}(:)?$/u.exec(cell.trim());
    if (!match) return null;
    alignments.push(match[1] && match[2] ? "center" : match[2] ? "right" : "left");
  }
  return alignments;
}

function inlineText(parts: readonly MdInline[]): string {
  return parts.map((part) => {
    if (part.type === "text" || part.type === "code") return part.text;
    if (part.type === "link") return inlineText(part.label);
    return inlineText(part.children);
  }).join("");
}

function isNumericCell(parts: readonly MdInline[]): boolean {
  return /^[-+]?\d[\d,]*(?:\.\d+)?%?$/u.test(inlineText(parts).trim());
}

function tryParseTable(lines: readonly string[], start: number): { block: Extract<MdBlock, { type: "table" }>; next: number } | null {
  const headerCells = splitTableCells(lines[start]);
  const dividerCells = start + 1 < lines.length ? splitTableCells(lines[start + 1]) : null;
  if (!headerCells || !dividerCells || headerCells.length !== dividerCells.length) return null;

  const align = parseTableAlignments(dividerCells);
  if (!align) return null;

  const rows: MdInline[][][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const cells = splitTableCells(lines[index]);
    if (!cells) break;
    if (cells.length !== headerCells.length) return null;
    rows.push(cells.map(parseInline));
    index += 1;
  }

  const header = headerCells.map(parseInline);
  const numeric = header.map((_, column) => rows.length > 0 && rows.every((row) => isNumericCell(row[column])));
  return { block: { type: "table", header, rows, align, numeric }, next: index };
}

function startsBlockAt(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  return /^#{1,6}\s+/u.test(line)
    || /^```/u.test(line)
    || /^>\s?/u.test(line)
    || isHorizontalRule(line)
    || listMatch(line) !== null
    || tryParseTable(lines, index) !== null;
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const table = tryParseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    const fence = /^```\s*(.*)$/u.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", lang: fence[1].trim() || null, text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      index += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) {
      blocks.push({ type: "quote", inline: parseInline(quote[1]) });
      index += 1;
      continue;
    }
    if (isHorizontalRule(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }
    const firstList = listMatch(line);
    if (firstList) {
      const list = parseList(lines, index, firstList.indent, firstList.ordered);
      blocks.push(list.block);
      index = list.next;
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlockAt(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", inline: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}
