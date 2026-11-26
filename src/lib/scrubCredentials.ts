/** Keep this legacy policy stable for the jev grouping payload. */
export function scrubJevCredentials(value: string): string {
  return value.replace(/(?:sk-or-|sk-proj-|github_pat_|ghp_)[A-Za-z0-9_-]{12,}/g, "[credential omitted]")
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g, "[credential omitted]");
}

export const OMITTED = "[credential omitted]";
interface Mask {
  start: number;
  end: number;
  quoted?: boolean; // L5 wraps an unquoted value of a quoted key in JSON quotes.
}

function renderMasks(value: string, masks: Mask[]): string {
  if (!masks.length) return value;
  let result = "", from = 0;
  for (const { start, end, quoted } of masks) {
    result += value.slice(from, start) + (quoted ? '"' + OMITTED + '"' : OMITTED);
    from = end;
  }
  return result + value.slice(from);
}

function unionMasks(masks: Mask[]): Mask[] {
  masks.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Mask[] = [];
  for (const mask of masks) {
    const last = merged[merged.length - 1];
    if (last && (mask.start < last.end || mask.start === last.start)) {
      last.end = Math.max(last.end, mask.end);
      if (mask.start === last.start && mask.quoted) last.quoted = true;
    } else {
      merged.push({ ...mask });
    }
  }
  return merged;
}

// Later scanners see the earlier bare markers. Project their sorted ranges back
// onto the source. A boundary inside a marker covers that whole original span.
function sourceMasks(earlier: Mask[], later: Mask[]): Mask[] {
  if (!earlier.length) return later;
  if (!later.length) return earlier;
  let index = 0, delta = 0;
  function offset(position: number, right: boolean): number {
    while (index < earlier.length) {
      const mask = earlier[index];
      const start = mask.start + delta;
      if (position <= start) break;
      if (position < start + OMITTED.length) return right ? mask.end : mask.start;
      delta += OMITTED.length - (mask.end - mask.start);
      index++;
    }
    return position - delta;
  }
  const projected = later.map(mask => ({
    start: offset(mask.start, false), end: offset(mask.end, true), quoted: mask.quoted,
  }));
  return unionMasks(earlier.concat(projected));
}

const PREFIXES: ReadonlyArray<readonly [string, number, boolean]> = [
  ["sk-or-", 12, false], ["sk-proj-", 12, false], ["github_pat_", 12, false], ["ghp_", 12, false],
  ["sk-ant-", 1, false], ["xoxb-", 1, false], ["xoxp-", 1, false],
  ["xoxa-", 1, false], ["xoxs-", 1, false], ["xoxr-", 1, false], ["xapp-", 1, false],
  ["gho_", 1, false], ["ghs_", 1, false], ["ghu_", 1, false], ["ghr_", 1, false],
  ["glpat-", 20, false], ["AKIA", 16, true], ["ASIA", 16, true], ["sk-", 17, false],
];
const ARGUMENTS = new Set(["--password", "--token", "--secret", "--api-key"]);
const width = (value: string, at: number) => value.codePointAt(at)! > 0xffff ? 2 : 1;
const space = (value: string) => /\s/u.test(value);
const identifier = (value: string) => /[A-Za-z0-9_-]/.test(value);
function asciiAt(value: string, at: number, needle: string): boolean {
  for (let n = 0; n < needle.length; n++) {
    let c = value.charCodeAt(at + n);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== needle.charCodeAt(n)) return false;
  }
  return true;
}
function prefixMasks(value: string): Mask[] {
  const masks: Mask[] = [];
  scan: for (let i = 0; i < value.length;) {
    for (const [prefix, minimum, aws] of PREFIXES) {
      if (!value.startsWith(prefix, i)) continue;
      if (prefix.startsWith("sk-") && i > 0 && /[A-Za-z0-9]/.test(value[i - 1])) continue;
      const start = i + prefix.length;
      let end = start;
      const limit = aws ? Math.min(value.length, start + minimum) : value.length;
      const allowed = aws ? /[A-Z0-9]/ : /[A-Za-z0-9_-]/;
      while (end < limit && allowed.test(value[end])) end++;
      if (end - start >= minimum && (!aws || end === value.length || !allowed.test(value[end]))) {
        masks.push({ start: i, end }); i = end; continue scan;
      }
    }
    i += width(value, i);
  }
  return masks;
}
function skipSpace(value: string, at: number): number {
  while (at < value.length && space(value[at])) at++;
  return at;
}
function isQuote(c: string | undefined): c is "'" | '"' {
  return c === "'" || c === '"';
}

function quotedEnd(value: string, at: number, multiline: boolean): { end: number; closed: boolean } {
  const quote = value[at];
  let end = at + 1;
  while (end < value.length && (multiline || !lineBreak.test(value[end]))) {
    if (value[end] === "\\" && end + 1 < value.length) {
      end += 1 + width(value, end + 1);
    } else if (quote === "'" && value.startsWith("''", end)) {
      end += 2;
    } else if (value[end] === quote) {
      return { end: end + 1, closed: true };
    } else {
      end += width(value, end);
    }
  }
  return { end, closed: false };
}

function lineBeginning(value: string, at: number): number {
  while (at > 0 && !lineBreak.test(value[at - 1])) at--;
  return at;
}

function lineEnd(value: string, at: number): number {
  while (at < value.length && !lineBreak.test(value[at])) at++;
  return at;
}

function indentedValueEnd(value: string, key: number, start: number, sequence = false): number | undefined {
  const indent = key - lineBeginning(value, key);
  let end = start;
  let at = start;
  while (at < value.length) {
    const column = at - lineBeginning(value, at);
    const item = sequence && column === indent && value[at] === "-"
      && (at + 1 === value.length || space(value[at + 1]));
    if (column <= indent && !item) {
      if (!sequence || value[at] !== "#") break;
      at = skipSpace(value, lineEnd(value, at));
      continue;
    }
    end = lineEnd(value, at);
    at = skipSpace(value, end);
  }
  while (end > start && space(value[end - 1])) end--;
  return end > start ? end : undefined;
}

function structuredEnd(value: string, at: number, flow = false): number {
  const closing: string[] = [];
  for (let end = at; end < value.length;) {
    const c = value[end];
    if (isQuote(c)) {
      end = quotedEnd(value, end, true).end;
      continue;
    }
    if (flow && c === "#" && space(value[end - 1])) {
      end = lineEnd(value, end);
      continue;
    }
    if (c === "{" || c === "[") closing.push(c === "{" ? "}" : "]");
    else if (c === closing[closing.length - 1]) {
      closing.pop();
      if (closing.length === 0) return end + 1;
    }
    end += width(value, end);
  }
  return value.length;
}

function valueEnd(value: string, start: number, mode: "word" | "line" | "flow" | "query"): number {
  if (isQuote(value[start])) return quotedEnd(value, start, true).end;
  if (mode !== "word" && mode !== "query" && !value.startsWith(OMITTED, start)
    && (value[start] === "{" || value[start] === "[")) return structuredEnd(value, start);
  let end = start;
  let contentEnd = start;
  while (end < value.length) {
    const c = value[end];
    if (value.startsWith(OMITTED, end)) {
      end += OMITTED.length;
      contentEnd = end;
      continue;
    }
    if (lineBreak.test(c)
      || (mode === "word" && space(c))
      || (mode === "query" && (space(c) || c === "&" || c === "#" || isQuote(c)))
      || (mode === "flow" && (c === "," || c === "}" || c === "]"))) break;
    end += width(value, end);
    if (!space(c)) contentEnd = end;
  }
  return contentEnd;
}

function valueMask(value: string, start: number, end: number, quotedKey: boolean): Mask {
  if (isQuote(value[start])) {
    return { start: start + 1, end: end - Number(quotedEnd(value, start, true).closed) };
  }
  return { start, end, quoted: quotedKey };
}

function authorizationHeaderStart(value: string, at: number): [start: number, allowQuotedParameter: boolean] | null {
  if (!asciiAt(value, at, "authorization")) return null;
  at += 13;
  if (value[at] === "'" || value[at] === '"') at++;
  at = skipSpace(value, at);
  if (value[at] !== ":") return null;
  at = skipSpace(value, at + 1);
  if (value[at] === "'" || value[at] === '"') at++;
  const scheme = ["basic", "token", "apikey"].find(scheme => asciiAt(value, at, scheme));
  if (!scheme) return null;
  const after = at + scheme.length, start = skipSpace(value, after);
  return start > after ? [start, scheme !== "basic"] : null;
}
function authorizationParameter(value: string, at: number): number | undefined {
  const field = assignmentAt(value, at);
  if (!field || field.key === null) return;
  const start = field.start;
  const escapedQuote = value[start] === "\\" && isQuote(value[start + 1]);
  // A generic named parameter needs a quoted value. A lone '=' can be Base64 padding.
  if (!credentialKey(field.key) && !(field.delimiter === "=" && (isQuote(value[start]) || escapedQuote))) return;
  if (escapedQuote) {
    const closing = value.indexOf(value.slice(start, start + 2), start + 2);
    const end = lineEnd(value, start);
    return closing >= 0 && closing < end ? closing + 2 : end;
  }
  if (isQuote(value[start])) return quotedEnd(value, start, false).end;
  let end = start;
  while (end < value.length && !space(value[end]) && !isQuote(value[end]) && value[end] !== ",") {
    end += width(value, end);
  }
  return end;
}

function l5AuthorizationValue(value: string, at: number, minimum: number, allowParameter: boolean): Mask | null {
  if (allowParameter) {
    const end = authorizationParameter(value, at);
    if (end !== undefined) return { start: at, end };
  }
  const start = at + (isQuote(value[at]) ? 1 : 0);
  let end = start;
  while (end < value.length && /[A-Za-z0-9._~+/=-]/.test(value[end])) end++;
  return end - start >= minimum ? { start, end } : null;
}

function v09014AuthorizationValue(value: string, at: number, minimum: number, allowQuotedParameter: boolean): Mask | null {
  const first = value[at];
  const start = at + (first === "'" || first === '"' ? 1 : 0);
  let end = start;
  while (end < value.length && /[A-Za-z0-9._~+/=-]/.test(value[end])) end++;
  if (end - start < minimum) return null;
  const extendParameter = allowQuotedParameter && value[end - 1] === "=" && value[end] !== first;
  let quoteAt = end;
  while (extendParameter && (value[quoteAt] === " " || value[quoteAt] === "\t")) quoteAt++;
  const quote = value[quoteAt];
  if (extendParameter && (quote === "'" || quote === '"')) {
    end = quoteAt + 1;
    let escaped = false;
    while (end < value.length && !lineBreak.test(value[end])) {
      const c = value[end++];
      if (!escaped && c === quote) break;
      escaped = !escaped && c === "\\";
    }
  } else if (extendParameter && quoteAt === end) {
    while (end < value.length && !space(value[end])) end += width(value, end);
  }
  return { start, end };
}
function authorizationMasks(value: string, readValue: typeof l5AuthorizationValue): Mask[] {
  const masks: Mask[] = [];
  for (let i = 0; i < value.length;) {
    const boundary = i === 0 || !/[A-Za-z0-9_]/.test(value[i - 1]);
    let header: [number, boolean] | null = null, bearer = false;
    if (boundary && asciiAt(value, i, "bearer")) {
      const after = i + 6, candidate = skipSpace(value, after);
      if (candidate > after) { header = [candidate, false]; bearer = true; }
    } else if (boundary) header = authorizationHeaderStart(value, i);
    if (header) {
      const [start, allowQuotedParameter] = header;
      const masked = readValue(value, start, bearer ? 16 : 1, allowQuotedParameter);
      if (masked) { masks.push(masked); i = masked.end; continue; }
    }
    i += width(value, i);
  }
  return masks;
}
const V09014_KEYS: readonly string[] = [
  "password", "passwd", "pwd", "token", "secret", "apikey",
  "api_key", "access_key", "secret_key", "private_key",
  "pgpassword", "sig", "x-amz-signature", "sessionid",
];
export const PRESEND_CREDENTIAL_KEYS: readonly string[] = [...V09014_KEYS, "session_id"];
function credentialParts(parts: string[], keys: readonly string[]): boolean {
  return parts.some((part, i) => keys.includes(part)
    || keys.includes(`${part}_${parts[i + 1]}`));
}
const lowerAscii = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase());
function credentialKey(key: string, keys = PRESEND_CREDENTIAL_KEYS): boolean {
  const lower = lowerAscii(key);
  if (keys.includes(lower) || credentialParts(lower.split(/[_-]/), keys)) return true;
  // Check the original boundaries before further splitting acronyms.
  const camelCase = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (credentialParts(lowerAscii(camelCase).split(/[_-]/), keys)) return true;
  const words = camelCase.replace(/([A-Z])(?=[A-Z][a-z])/g, "$1_");
  return lower === "dbpassword" || credentialParts(lowerAscii(words).split(/[_-]/), keys);
}
const assignmentDelimiters = ["=>", ":=", "=", ":", "\uff1d", "\uff1a"];
const lineBreak = /[\n\r\u2028\u2029]/u;

function assignmentDelimiter(value: string, at: number): string | undefined {
  return assignmentDelimiters.find(delimiter => value.startsWith(delimiter, at));
}

function startsAssignment(value: string, start: number): boolean {
  const quote = value[start] === "'" || value[start] === '"' ? value[start] : "";
  const keyStart = start + quote.length;
  let end = keyStart;
  while (end < value.length && identifier(value[end])) end++;
  if (end === keyStart || (quote && value[end] !== quote)) return false;
  end += quote.length;
  const at = skipSpace(value, end);
  const delimiter = value[at];
  if (lineBreak.test(value.slice(end, at)) || (delimiter !== ":" && delimiter !== "=")) return false;
  const after = at + 1;
  if (after < value.length && !space(value[after])) return false;
  if (delimiter === ":" || at > end) return true;
  // A bare '=' at the end of a line may be Base64 padding.
  const body = skipSpace(value, after);
  return body < value.length && !lineBreak.test(value.slice(after, body));
}


interface Assignment {
  key: string | null;
  quoted: boolean;
  escaped: boolean;
  at: number;
  delimiter: string;
  after: number;
  start: number;
}

const keyEscapes: Readonly<Record<string, string>> = {
  b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
};

function decodeQuotedKey(raw: string): string | null {
  let decoded = "";
  for (let i = 0; i < raw.length;) {
    const size = width(raw, i);
    if (raw[i] !== "\\") {
      decoded += raw.slice(i, i + size);
      i += size;
      continue;
    }
    const escape = raw[++i];
    const digits = escape === "u" ? 4 : escape === "x" ? 2 : escape === "U" ? 8 : 0;
    if (digits) {
      const hex = raw.slice(i + 1, i + 1 + digits);
      if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) return null;
      let point = Number.parseInt(hex, 16);
      i += digits + 1;
      if (point >= 0xd800 && point <= 0xdfff) {
        if (escape !== "u" || point > 0xdbff || !raw.startsWith("\\u", i)) return null;
        const low = raw.slice(i + 2, i + 6);
        if (!/^[dD][c-fC-F][0-9a-fA-F]{2}$/.test(low)) return null;
        point = 0x10000 + ((point - 0xd800) << 10) + (Number.parseInt(low, 16) - 0xdc00);
        i += 6;
      }
      if (point > 0x10ffff) return null;
      decoded += String.fromCodePoint(point);
    } else {
      // Some escape letters have different meanings in YAML and script
      // strings. An ambiguous name with one of those escapes is unsafe.
      if (!escape || /[0-9aeN_LP]/.test(escape) || lineBreak.test(escape)) return null;
      const size = width(raw, i);
      decoded += keyEscapes[escape] ?? raw.slice(i, i + size);
      i += size;
    }
  }
  return decoded;
}

function isStructuredCredentialKey(key: string): boolean {
  return key.toLowerCase() === "authorization" || credentialKey(key);
}

function assignmentAt(value: string, index: number): Assignment | undefined {
  const quoted = isQuote(value[index]);
  let keyEnd = index;
  let raw: string;
  if (quoted) {
    if (value[index - 1] === "\\") return;
    const key = quotedEnd(value, index, true);
    if (!key.closed) return;
    keyEnd = key.end;
    raw = value.slice(index + 1, keyEnd - 1);
    if (!raw.includes("\\") && !/^[A-Za-z0-9_-]+$/.test(raw)) return;
  } else {
    while (keyEnd < value.length && identifier(value[keyEnd])) keyEnd++;
    if (keyEnd === index) return;
    raw = value.slice(index, keyEnd);
  }
  const delimiterAt = skipSpace(value, keyEnd);
  const delimiter = assignmentDelimiter(value, delimiterAt);
  if (!delimiter) return;
  const after = delimiterAt + delimiter.length;
  const escaped = quoted && raw.includes("\\");
  return { key: escaped ? decodeQuotedKey(raw) : raw, quoted, escaped, at: index,
    delimiter, after, start: skipSpace(value, after) };
}

function siblingAssignment(value: string, fieldAt: number, end: number, flow: boolean): Assignment | undefined {
  let at = end;
  while (value[at] === " " || value[at] === "\t") at++;
  if (value[at] === "#") at = lineEnd(value, at);
  if (flow) {
    at = skipSpace(value, at);
    while (value[at] === "#") at = skipSpace(value, lineEnd(value, at));
    if (value[at] !== ",") return;
  } else if (at === value.length || !lineBreak.test(value[at])) {
    return;
  }
  at = skipSpace(value, at + 1);
  const indent = flow ? 0 : fieldAt - lineBeginning(value, fieldAt);
  while (at < value.length && (value[at] === "#" || (!flow && at - lineBeginning(value, at) > indent))) {
    at = skipSpace(value, lineEnd(value, at));
  }
  if (!flow && at - lineBeginning(value, at) !== indent) return;
  const sibling = assignmentAt(value, at);
  return sibling?.delimiter === ":" ? sibling : undefined;
}

type EnvironmentName = "ordinary" | "credential" | "omit-reading";

function skipYamlComments(value: string, at: number): number {
  at = skipSpace(value, at);
  while (value[at] === "#") at = skipSpace(value, lineEnd(value, at));
  return at;
}

function environmentMemberStart(value: string, field: Assignment, flow: boolean): number {
  const start = skipYamlComments(value, field.start);
  if (flow) return start;
  const end = lineEnd(value, field.after);
  if (start <= end) return start;
  const indent = field.at - lineBeginning(value, field.at);
  // Every block member, not just the name, ends before the next sibling.
  return start < value.length && start - lineBeginning(value, start) > indent ? start : end;
}

function environmentName(value: string, start: number): EnvironmentName {
  if (isQuote(value[start])) {
    const { end, closed } = quotedEnd(value, start, true);
    if (!closed) return "omit-reading";
    const raw = value.slice(start + 1, end - 1);
    if (raw.includes("\\")) {
      const decoded = decodeQuotedKey(raw);
      // Escaped credential names in split records are not sent for reading.
      return decoded === null || isStructuredCredentialKey(decoded) ? "omit-reading" : "ordinary";
    }
    return /^[A-Za-z0-9_-]+$/.test(raw) && credentialKey(raw) ? "credential" : "ordinary";
  }
  let end = start;
  while (end < value.length && identifier(value[end])) end++;
  if (end === start) return "omit-reading";
  const bounded = end === value.length || space(value[end]) || ",}]".includes(value[end]);
  return bounded && credentialKey(value.slice(start, end)) ? "credential" : "ordinary";
}

function environmentValue(value: string, field: Assignment, flow: boolean): { at: number; omitReading: boolean } | undefined {
  const key = field.key?.toLowerCase();
  if (field.delimiter !== ":" || (key !== "name" && key !== "value")) return;
  let member = field;
  let start = environmentMemberStart(value, member, flow);
  const name = key === "name" ? environmentName(value, start) : undefined;
  if (name === "ordinary") return;
  for (;;) {
    // A flow boundary that cannot be established must not hide a sibling.
    const end = flow ? yamlFlowNodeEnd(value, start) : valueEnd(value, start, "line");
    if (end === null) return { at: field.at, omitReading: true };
    const next = siblingAssignment(value, field.at, end, flow);
    if (!next || next.at <= member.at) return;
    const nextKey = next.key?.toLowerCase();
    if (nextKey === key) return;
    start = environmentMemberStart(value, next, flow);
    if (nextKey === (key === "name" ? "value" : "name")) {
      const pairedName = name ?? environmentName(value, start);
      if (pairedName === "ordinary") return;
      return { at: key === "name" ? next.at : field.at, omitReading: pairedName === "omit-reading" };
    }
    member = next;
  }
}

function settingValue(key: string, body: string, yaml: boolean): boolean {
  const scalar = yaml ? body.replace(/[ \t]+#.*$/, "") : body;
  switch (key.toLowerCase()) {
    case "sig_version":
    case "sigversion":
    case "httptokencount":
    case "oauthtokencount":
    case "token_count":
      return /^[0-9]+$/.test(scalar);
    case "use-sig":
      return /^(?:true|false)$/i.test(scalar);
    default:
      return false;
  }
}

const schemeChar = /[A-Za-z0-9+.-]/;
const hostWithPort = /^(?:[A-Za-z0-9._%-]+|\[[0-9A-Fa-f:.%]+\])(?::[0-9]{1,5})?$/;

function urlAuthority(value: string, start: number, masks: Mask[]): number | undefined {
  if (!/[A-Za-z]/.test(value[start]) || (start > 0 && schemeChar.test(value[start - 1]))) return;
  let at = start + 1;
  while (at < value.length && schemeChar.test(value[at])) at++;
  if (!value.startsWith("://", at)) return;
  const body = at + 3;
  let end = body;
  let lastAt = -1;
  while (end < value.length) {
    if (value.startsWith(OMITTED, end)) {
      end += OMITTED.length;
      continue;
    }
    const c = value[end];
    if (space(c) || "/?#<>\"\u0060".includes(c)) break;
    if (c === "@") lastAt = end;
    end += width(value, end);
  }
  if (lastAt < body) {
    let hostEnd = end;
    while (hostEnd > body && "')],".includes(value[hostEnd - 1])) {
      if (value[hostEnd - 1] === "]" && value[body] === "[") break;
      hostEnd--;
    }
    return hostWithPort.test(value.slice(body, hostEnd)) ? hostEnd : undefined;
  }
  const colon = value.indexOf(":", body);
  const password = colon >= body && colon < lastAt ? colon : lastAt;
  const user = value.slice(body, password);
  for (let i = 0; i < user.length; i++) {
    if (i > 0 && identifier(user[i - 1])) continue;
    const field = assignmentAt(user, i);
    if (field?.key && credentialKey(field.key)) {
      masks.push({ start: body + (i === 0 ? field.start : 0), end: password });
      break;
    }
  }
  if (password < lastAt) masks.push({ start: password + 1, end: lastAt });
  return end;
}

function assignmentMask(value: string, field: Assignment, flow: boolean): [mask: Mask, next: number] | undefined {
  const { at, start, quoted } = field;
  const query = at > 0 && (value[at - 1] === "?" || value[at - 1] === "&");
  const yaml = !query && !flow && field.delimiter === ":"
    && ["", "-"].includes(value.slice(lineBeginning(value, at), at).trim());
  const crossesLine = lineBreak.test(value.slice(field.after, start));
  if (yaml && !crossesLine && (value[start] === "|" || value[start] === ">")) {
    const end = lineEnd(value, start);
    if (/^[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/.test(value.slice(start, end))) {
      const blockStart = skipSpace(value, end);
      const blockEnd = indentedValueEnd(value, at, blockStart);
      return blockEnd !== undefined ? [{ start: blockStart, end: blockEnd }, blockEnd] : undefined;
    }
  }
  const quotedValue = isQuote(value[start]) && assignmentAt(value, start) === undefined;
  if (crossesLine && !query && !flow && (!quoted || yaml) && start < value.length && !quotedValue) {
    const blockEnd = indentedValueEnd(value, at, start, yaml);
    if (blockEnd !== undefined) return [{ start, end: blockEnd, quoted }, blockEnd];
    if (startsAssignment(value, start)) return;
  }
  if (!query && !quotedValue && isQuote(value[start])) {
    const end = lineEnd(value, start);
    return [{ start, end }, end];
  }
  let end = valueEnd(value, start, query ? "query" : flow || (quoted && !yaml) ? "flow" : "line");
  if (!crossesLine && yaml && !quotedValue && end > start) {
    const continuation = skipSpace(value, lineEnd(value, end));
    end = indentedValueEnd(value, at, continuation, value[start] === "#") ?? end;
  }
  if (start === end || settingValue(field.key ?? "", value.slice(start, end), yaml)) return;
  return [valueMask(value, start, end, quoted), end];
}

function yamlNodePosition(value: string, at: number, flow: boolean): { column: number; afterColon: boolean } | undefined {
  let left = at;
  while (value[left - 1] === " " || value[left - 1] === "\t") left--;
  if (left === 0 || lineBreak.test(value[left - 1])) return { column: at - left, afterColon: false };
  const previous = value[left - 1];
  if (flow && ":[{,".includes(previous)) return { column: 0, afterColon: previous === ":" };
  if ((previous !== ":" && previous !== "-") || left === at) return;
  const prefix = value.slice(lineBeginning(value, left - 1), left);
  if (previous === "-") {
    if (/^[ \t]*-$/.test(prefix)) return { column: prefix.length - 1, afterColon: false };
    return;
  }
  return { column: /^[ \t]*(?:-[ \t]+)?/.exec(prefix)![0].length, afterColon: true };
}

function yamlPropertyEnd(value: string, at: number): number | undefined {
  const marker = value[at];
  const next = value[at + 1];
  if (marker === "?") return !next || space(next) ? at + 1 : undefined;
  if (!"&*!".includes(marker)) return;
  if (marker === "!" && next === "<") {
    const end = value.indexOf(">", at + 2);
    if (end > at && end < lineEnd(value, at)) return end + 1;
  }
  let end = at + 1;
  while (end < value.length && !space(value[end]) && !",[]{}=\"'".includes(value[end])) end++;
  if (marker === "*" && value.slice(at + 1, end).includes("*")) return;
  return end > at + 1 || marker === "!" ? end : undefined;
}

// Return the end of the actual flow value, not the legacy mask span.
function yamlFlowNodeEnd(value: string, start: number): number | null {
  const closing: string[] = [];
  let mode: "start" | "plain" | "closed" = "start";
  let end = start;
  for (let at = start; at < value.length;) {
    const c = value[at];
    if (space(c)) {
      at = skipSpace(value, at);
      continue;
    }
    if (c === "#" && (at === start || space(value[at - 1]))) {
      at = lineEnd(value, at);
      continue;
    }
    if (",]}".includes(c)) {
      if (closing.length === 0) return end;
      if (c !== ",") {
        if (closing.pop() !== c) return null;
        mode = "closed";
      } else {
        mode = "start";
      }
    } else if (c === ":" && closing.length > 0 && (mode === "closed"
      || at + 1 === value.length || space(value[at + 1]) || ",[]{}".includes(value[at + 1]))) {
      mode = "start";
    } else if (mode === "start" && isQuote(c)) {
      const quoted = quotedEnd(value, at, true);
      if (!quoted.closed) return null;
      at = end = quoted.end;
      mode = "closed";
      continue;
    } else if (mode === "start" && "&*!?".includes(c)) {
      const property = yamlPropertyEnd(value, at);
      if (property !== undefined) {
        at = end = property;
        if (c === "*") mode = "closed";
        continue;
      }
      mode = "plain";
    } else if (mode === "start" && (c === "{" || c === "[")) {
      closing.push(c === "{" ? "}" : "]");
    } else {
      if (mode === "closed" || c === "{" || c === "[") return null;
      mode = "plain";
    }
    at += width(value, at);
    end = at;
  }
  return null;
}

function yamlInlineNodeEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length) {
    const current = value[end];
    if (lineBreak.test(current)) break;
    if (current === "#" && space(value[end - 1])) {
      end = lineEnd(value, end);
    } else if (current === "{" || current === "[") {
      end = structuredEnd(value, end, false);
    } else if (isQuote(current) && !identifier(value[end - 1])) {
      end = quotedEnd(value, end, true).end;
    } else {
      end += width(value, end);
    }
  }
  return end;
}

function yamlValueIndicator(value: string, at: number, flow: boolean): boolean {
  return value[at] === ":" && (flow || at + 1 === value.length || space(value[at + 1]));
}

function yamlScalarTailIsKnown(node: string, end: number): boolean {
  const tail = node.slice(skipSpace(node, end));
  return !tail || (tail.startsWith("#") && !lineBreak.test(tail));
}

function yamlAnchorMayNameCredential(node: string): boolean {
  let at = skipSpace(node, 0);
  while (node[at] === "!") at = skipSpace(node, yamlPropertyEnd(node, at)!);
  // Only a scalar we can classify may clear a previous sensitive binding.
  if (at === node.length) return true;
  if (isQuote(node[at])) {
    const { end, closed } = quotedEnd(node, at, true);
    if (!closed || lineBreak.test(node.slice(at, end)) || !yamlScalarTailIsKnown(node, end)) return true;
    const decoded = decodeQuotedKey(node.slice(at + 1, end - 1));
    return decoded === null || isStructuredCredentialKey(decoded);
  }
  let end = at;
  while (end < node.length && identifier(node[end])) end++;
  return end === at || !yamlScalarTailIsKnown(node, end) || isStructuredCredentialKey(node.slice(at, end));
}

function yamlExplicitKeyIsSensitive(key: string, credentialAnchors: Set<string>): boolean {
  for (let at = 0; at < key.length;) {
    if (key[at] === "#" && (at === 0 || space(key[at - 1]))) {
      at = lineEnd(key, at);
    } else if (isQuote(key[at])) {
      const { end, closed } = quotedEnd(key, at, true);
      if (!closed) return true;
      const decoded = decodeQuotedKey(key.slice(at + 1, end - 1));
      if (decoded === null || isStructuredCredentialKey(decoded)) return true;
      at = end;
    } else if ("&*!".includes(key[at])) {
      const end = yamlPropertyEnd(key, at) ?? at + 1;
      if (key[at] === "*" && credentialAnchors.has(key.slice(at + 1, end))) return true;
      at = end;
    } else if (identifier(key[at])) {
      let end = at + 1;
      while (end < key.length && identifier(key[end])) end++;
      if (isStructuredCredentialKey(key.slice(at, end))) return true;
      at = end;
    } else {
      at += width(key, at);
    }
  }
  return false;
}

// Record the values or explicit keys affected by YAML node properties. A
// property can cover its nested children but ends at the next sibling node.
function yamlNodeScopes(value: string): Mask[] | null {
  const scopes: Mask[] = [];
  const credentialAnchors = new Set<string>();
  const closing: string[] = [];
  for (let at = 0; at < value.length;) {
    const current = value[at];
    const flow = closing.length > 0;
    if (!flow && (at === 0 || lineBreak.test(value[at - 1]))) {
      const directive = value.slice(at, at + 3);
      if ((directive === "---" || directive === "...") && (at + 3 === value.length || space(value[at + 3]))) {
        credentialAnchors.clear();
      }
      if (directive === "\u0060\u0060\u0060" || directive === "~~~") credentialAnchors.clear();
    }
    if (current === "#" && (at === 0 || space(value[at - 1]))) {
      at = lineEnd(value, at);
      continue;
    }
    if (isQuote(current) && (flow ? yamlNodePosition(value, at, true)
      : at === 0 || (!identifier(value[at - 1]) && value[at - 1] !== "\\"))) {
      const { end, closed } = quotedEnd(value, at, true);
      if (closed) {
        at = end;
        continue;
      }
      if (flow || (yamlNodePosition(value, at, false) && value.slice(at, lineEnd(value, at)).includes("\\"))) return null;
    }
    if ("&*!?".includes(current)) {
      const body = yamlPropertyEnd(value, at);
      const position = body === undefined ? undefined : yamlNodePosition(value, at, flow);
      if (body !== undefined && position) {
        const { column, afterColon } = position;
        let end = flow ? yamlFlowNodeEnd(value, body) : yamlInlineNodeEnd(value, body);
        if (end === null) return null;
        let next = skipSpace(value, end);
        if (!flow) {
          const markerOnly = /^[ \t]*(?:#.*)?$/.test(value.slice(body, end));
          while (next < value.length) {
            if (value[next] === "#") {
              next = skipSpace(value, lineEnd(value, next));
              continue;
            }
            const indent = next - lineBeginning(value, next);
            const sequence = markerOnly && afterColon && indent === column && value[next] === "-"
              && (next + 1 === value.length || space(value[next + 1]));
            if (indent <= column && !sequence) break;
            end = yamlInlineNodeEnd(value, next);
            next = skipSpace(value, end);
          }
        }
        const name = value.slice(at + 1, body);
        if (current === "&") {
          // A later alias may use this scalar as a mapping key.
          if (yamlAnchorMayNameCredential(value.slice(body, end))) credentialAnchors.add(name);
          else credentialAnchors.delete(name);
        } else if (current === "*" && !afterColon && credentialAnchors.has(name)) {
          const delimiter = skipSpace(value, body);
          if (!lineBreak.test(value.slice(body, delimiter)) && yamlValueIndicator(value, delimiter, flow)) return null;
        } else if (current === "?" && (flow || yamlValueIndicator(value, next, false))
          && yamlExplicitKeyIsSensitive(value.slice(body, end), credentialAnchors)) {
          return null;
        }
        scopes.push({ start: at, end });
        // Keep scanning the marked node itself for nested properties.
        at = body;
        continue;
      }
    }
    if (current === "{" || current === "[") closing.push(current === "{" ? "}" : "]");
    else if (current === closing[closing.length - 1]) closing.pop();
    at += width(value, at);
  }
  return unionMasks(scopes);
}

function ambiguousCredentialField(value: string, field: Assignment, flow: boolean, end: number): boolean {
  if (field.delimiter !== ":") return false;
  const { at, start } = field;
  if (isQuote(value[start]) && !quotedEnd(value, start, true).closed) return true;
  if (flow) {
    const next = skipSpace(value, end);
    return next < value.length && !",}]".includes(value[next]) && lineBreak.test(value.slice(end, next));
  }
  const line = lineBeginning(value, at);
  const prefix = value.slice(line, at);
  const indent = /^[ \t]*(?:-[ \t]+)?$/.test(prefix) ? prefix.length : /^[ \t]*/.exec(prefix)![0].length;
  let next = skipSpace(value, lineEnd(value, end));
  while (value[next] === "#") next = skipSpace(value, lineEnd(value, next));
  return next < value.length && next - lineBeginning(value, next) > indent;
}

function l5AssignmentMasks(value: string, escapedKeys?: Mask[]): { masks: Mask[]; ambiguous: boolean } {
  const checkBoundaries = escapedKeys !== undefined;
  const masks: Mask[] = [];
  const yamlScopes = checkBoundaries ? yamlNodeScopes(value) : [];
  if (yamlScopes === null) return { masks, ambiguous: true };
  let yamlIndex = 0;
  const closing: string[] = [];
  const environmentValues = new Set<number>();
  let quotedThrough = 0;
  for (let i = 0; i < value.length;) {
    const c = value[i];
    const flow = closing.length > 0 && i >= quotedThrough;
    if ((identifier(c) || isQuote(c)) && (i === 0 || !identifier(value[i - 1]))) {
      const uri = identifier(c) ? urlAuthority(value, i, masks) : undefined;
      if (uri) {
        i = uri;
        continue;
      }
      const field = assignmentAt(value, i);
      if (checkBoundaries && field?.key === null) return { masks, ambiguous: true };
      const paired = field && environmentValue(value, field, flow);
      if (checkBoundaries && paired?.omitReading) return { masks, ambiguous: true };
      // Continue inspecting the fields in between; they can be secrets too.
      if (paired && paired.at !== i) environmentValues.add(paired.at);
      const authorization = field?.key?.toLowerCase() === "authorization";
      const secret = field && (environmentValues.delete(i) || paired?.at === i
        || (field.key !== null && (credentialKey(field.key) || (field.escaped && authorization))));
      const masked = secret && field ? assignmentMask(value, field, flow) : undefined;
      if (checkBoundaries && field && (secret || authorization)) {
        const end = masked?.[1] ?? valueEnd(value, field.start, flow ? "flow" : "line");
        while (yamlScopes[yamlIndex] && yamlScopes[yamlIndex].end <= i) yamlIndex++;
        const scope = yamlScopes[yamlIndex];
        const flowEnd = secret && flow && field.delimiter === ":" ? yamlFlowNodeEnd(value, field.start) : end;
        if (flowEnd === null || flowEnd > end
          || (i >= quotedThrough && field.delimiter === ":" && scope && scope.start < Math.max(field.after, end))
          || ambiguousCredentialField(value, field, flow, end)) {
          return { masks, ambiguous: true };
        }
      }
      if (masked) {
        if (field?.escaped) escapedKeys?.push(masked[0]);
        masks.push(masked[0]);
        i = masked[1];
        continue;
      }
      if (field?.quoted) {
        i = field.after;
        continue;
      }
      if (identifier(c)) {
        let end = i + 1;
        while (end < value.length && identifier(value[end])) end++;
        const start = skipSpace(value, end);
        if (!field && start > end && ARGUMENTS.has(value.slice(i, end).toLowerCase())) {
          const stop = valueEnd(value, start, "word");
          const body = start + Number(isQuote(value[start]));
          if (stop > start && value[body] !== "-") {
            masks.push(valueMask(value, start, stop, false));
            i = stop;
            continue;
          }
        }
        i = end;
        continue;
      }
    }
    if (i >= quotedThrough) {
      if (c === "#" && (i === 0 || space(value[i - 1]))) quotedThrough = lineEnd(value, i);
      else if (c === "{" || c === "[") closing.push(c === "{" ? "}" : "]");
      else if (c === closing[closing.length - 1]) closing.pop();
      else if (flow && isQuote(c) && yamlNodePosition(value, i, true)) quotedThrough = quotedEnd(value, i, true).end;
    }
    i += width(value, i);
  }
  return { masks, ambiguous: false };
}

function v09014MaskedValue(value: string, at: number, stopAtQuote: boolean,
  allowed: (body: string) => boolean = () => true): [number, Mask] | null {
  if (at >= value.length) return null;
  const quote = value[at] === "'" || value[at] === '"' ? value[at] : "";
  const start = at + quote.length;
  if (value.charCodeAt(start) > 127) return null;
  let end = start, closed = false, escaped = false;
  while (end < value.length) {
    if (!quote && value.startsWith(OMITTED, end)) { end += OMITTED.length; continue; }
    const c = value[end];
    if (quote) {
      if (!escaped && c === quote) { closed = true; break; }
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
    } else if (space(c) || (stopAtQuote && (c === "'" || c === '"'))) break;
    end += width(value, end);
  }
  if ((!quote && end === start) || !allowed(value.slice(start, end))) return null;
  return [end + (closed ? 1 : 0), { start, end }];
}
const userinfoChar = /[A-Za-z0-9._~%!$&'()*+,;=:-]/;

function urlPassword(value: string, start: number): [number, number] | null {
  if (!/[A-Za-z]/.test(value[start]) || (start > 0 && schemeChar.test(value[start - 1]))) return null;
  let at = start + 1;
  while (at < value.length && schemeChar.test(value[at])) at++;
  if (!value.startsWith("://", at)) return null;
  at += 3;
  let passwordStart = -1;
  while (at < value.length) {
    if (value.startsWith(OMITTED, at)) { at += OMITTED.length; continue; }
    const c = value[at];
    if (c === "@") return passwordStart >= 0 && passwordStart < at ? [passwordStart, at] : null;
    if (!userinfoChar.test(c) && (c.charCodeAt(0) <= 127 || space(c))) return null;
    if (c === ":" && passwordStart < 0) passwordStart = at + 1;
    at += width(value, at);
  }
  return null;
}

function v09014AssignmentMasks(value: string): Mask[] {
  const masks: Mask[] = [];
  for (let i = 0; i < value.length;) {
    if (identifier(value[i]) && (i === 0 || !identifier(value[i - 1]))) {
      const password = urlPassword(value, i);
      if (password) {
        const [start, end] = password;
        masks.push({ start, end });
        i = end + 1;
        continue;
      }
      let end = i;
      while (end < value.length && identifier(value[end])) end++;
      const key = value.slice(i, end);
      if (credentialKey(key, V09014_KEYS)) {
        const keyEnd = value[end] === "'" || value[end] === '"' ? end + 1 : end;
        const at = skipSpace(value, keyEnd);
        const delimiter = assignmentDelimiter(value, at);
        const argument = !delimiter && at > end && ARGUMENTS.has(key.toLowerCase());
        const valueFrom = delimiter ? at + delimiter.length : keyEnd;
        const start = delimiter ? skipSpace(value, valueFrom) : at;
        const nextAssignment = lineBreak.test(value.slice(valueFrom, start)) && startsAssignment(value, start);
        const masked = (delimiter || argument) && !nextAssignment ? v09014MaskedValue(value, start, false,
          body => !argument || !body.startsWith("-")) : null;
        if (masked) { masks.push(masked[1]); i = masked[0]; continue; }
      }
      i = end; continue;
    }
    i += width(value, i);
  }
  return masks;
}
function v09014Masks(value: string): Mask[] {
  const headers = authorizationMasks(value, v09014AuthorizationValue);
  return sourceMasks(headers, v09014AssignmentMasks(renderMasks(value, headers)));
}

function l5Masks(value: string): Mask[] {
  const headers = authorizationMasks(value, l5AuthorizationValue);
  return sourceMasks(headers, l5AssignmentMasks(renderMasks(value, headers)).masks);
}

/** Source UTF-16 offsets. Both policies share identical PEM and prefix matches. */
export function presendCredentialRanges(value: string): Mask[] {
  const pem: Mask[] = [];
  for (const match of value.matchAll(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g)) {
    pem.push({ start: match.index!, end: match.index! + match[0].length });
  }
  const common = sourceMasks(pem, prefixMasks(renderMasks(value, pem)));
  const prepared = renderMasks(value, common);
  return sourceMasks(common, unionMasks(v09014Masks(prepared).concat(l5Masks(prepared))));
}

export function scrubPresendCredentials(value: string): string {
  return renderMasks(value, presendCredentialRanges(value));
}

/** The reading pipeline can omit input whose credential value cannot be bounded. */
export function scrubPresendReadingInput(value: string): string | null {
  const escapedKeys: Mask[] = [];
  if (l5AssignmentMasks(value, escapedKeys).ambiguous) return null;
  // Another credential pattern can mask part of the key before the later
  // assignment scan. Retain these value spans from the original input.
  return renderMasks(value, unionMasks(presendCredentialRanges(value).concat(escapedKeys)));
}
