export type MdInline =
  | { type: "text"; text: string }
  | { type: "bold"; children: MdInline[] }
  | { type: "italic"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "link"; label: MdInline[]; url: string };

export type MdBlock =
  | { type: "heading"; level: number; inline: MdInline[] }
  | { type: "paragraph"; inline: MdInline[] }
  | { type: "list"; ordered: boolean; items: MdInline[][] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "quote"; inline: MdInline[] };

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

function listMatch(line: string): { ordered: boolean; text: string } | null {
  const unordered = /^[-*]\s+(.+)$/u.exec(line);
  if (unordered) return { ordered: false, text: unordered[1] };
  const ordered = /^\d+\.\s+(.+)$/u.exec(line);
  return ordered ? { ordered: true, text: ordered[1] } : null;
}

function startsBlock(line: string): boolean {
  return /^#{1,6}\s+/u.test(line) || /^```/u.test(line) || /^>\s?/u.test(line) || listMatch(line) !== null;
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
    const firstList = listMatch(line);
    if (firstList) {
      const items: MdInline[][] = [];
      const ordered = firstList.ordered;
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item || item.ordered !== ordered) break;
        items.push(parseInline(item.text));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", inline: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}
