/** Keep this legacy policy stable for the jev grouping payload. */
export function scrubJevCredentials(value: string): string {
  return value.replace(/(?:sk-or-|sk-proj-|github_pat_|ghp_)[A-Za-z0-9_-]{12,}/g, "[credential omitted]")
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g, "[credential omitted]");
}

export const OMITTED = "[credential omitted]";
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
function prefixes(value: string): string {
  let out = "";
  scan: for (let i = 0; i < value.length;) {
    for (const [prefix, minimum, aws] of PREFIXES) {
      if (!value.startsWith(prefix, i)) continue;
      if (prefix.startsWith("sk-") && i > 0 && /[A-Za-z0-9]/.test(value[i - 1])) continue;
      const start = i + prefix.length;
      let end = start;
      while (end < value.length && (aws ? /[A-Z0-9]/ : /[A-Za-z0-9_-]/).test(value[end])) end++;
      if (end - start >= minimum && (!aws || end - start === 16)) {
        out += OMITTED; i = end; continue scan;
      }
    }
    const count = width(value, i); out += value.slice(i, i + count); i += count;
  }
  return out;
}
function skipSpace(value: string, at: number): number {
  while (at < value.length && space(value[at])) at++;
  return at;
}
function maskedValue(value: string, at: number, stopAtQuote: boolean,
  allowed: (body: string) => boolean = () => true): [number, string] | null {
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
  return [end + (closed ? 1 : 0), quote + OMITTED + (closed ? quote : "")];
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
function authorizationValue(value: string, at: number, minimum: number, allowQuotedParameter: boolean): [number, string] | null {
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
  return [end, value.slice(at, start) + OMITTED];
}
function authorization(value: string): string {
  let out = "";
  for (let i = 0; i < value.length;) {
    const boundary = i === 0 || !/[A-Za-z0-9_]/.test(value[i - 1]);
    let header: [number, boolean] | null = null, bearer = false;
    if (boundary && asciiAt(value, i, "bearer")) {
      const after = i + 6, candidate = skipSpace(value, after);
      if (candidate > after) { header = [candidate, false]; bearer = true; }
    } else if (boundary) header = authorizationHeaderStart(value, i);
    if (header) {
      const [start, allowQuotedParameter] = header;
      const masked = authorizationValue(value, start, bearer ? 16 : 1, allowQuotedParameter);
      if (masked) { out += value.slice(i, start) + masked[1]; i = masked[0]; continue; }
    }
    const count = width(value, i); out += value.slice(i, i + count); i += count;
  }
  return out;
}
export const PRESEND_CREDENTIAL_KEYS: readonly string[] = [
  "password", "passwd", "pwd", "token", "secret", "apikey",
  "api_key", "access_key", "secret_key", "private_key",
  "pgpassword", "sig", "x-amz-signature", "sessionid",
];
function credentialParts(parts: string[]): boolean {
  return parts.some((part, i) => PRESEND_CREDENTIAL_KEYS.includes(part)
    || PRESEND_CREDENTIAL_KEYS.includes(`${part}_${parts[i + 1]}`));
}
function credentialKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (PRESEND_CREDENTIAL_KEYS.includes(lower) || credentialParts(lower.split(/[_-]/))) return true;
  // Check the original boundaries before further splitting acronyms.
  const camelCase = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (credentialParts(camelCase.toLowerCase().split(/[_-]/))) return true;
  const words = camelCase.replace(/([A-Z])(?=[A-Z][a-z])/g, "$1_");
  return lower === "dbpassword" || credentialParts(words.toLowerCase().split(/[_-]/));
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

const schemeChar = /[A-Za-z0-9+.-]/;
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

function assignments(value: string): string {
  let out = "";
  for (let i = 0; i < value.length;) {
    if (identifier(value[i]) && (i === 0 || !identifier(value[i - 1]))) {
      const password = urlPassword(value, i);
      if (password) {
        const [start, end] = password;
        out += value.slice(i, start) + OMITTED + "@";
        i = end + 1;
        continue;
      }
      let end = i;
      while (end < value.length && identifier(value[end])) end++;
      const key = value.slice(i, end);
      if (credentialKey(key)) {
        const keyEnd = value[end] === "'" || value[end] === '"' ? end + 1 : end;
        const at = skipSpace(value, keyEnd);
        const delimiter = assignmentDelimiter(value, at);
        const argument = !delimiter && at > end && ARGUMENTS.has(key.toLowerCase());
        const valueFrom = delimiter ? at + delimiter.length : keyEnd;
        const start = delimiter ? skipSpace(value, valueFrom) : at;
        const nextAssignment = lineBreak.test(value.slice(valueFrom, start)) && startsAssignment(value, start);
        const masked = (delimiter || argument) && !nextAssignment ? maskedValue(value, start, false,
          body => !argument || !body.startsWith("-")) : null;
        if (masked) { out += value.slice(i, start) + masked[1]; i = masked[0]; continue; }
      }
      out += value.slice(i, end); i = end; continue;
    }
    const count = width(value, i); out += value.slice(i, i + count); i += count;
  }
  return out;
}
/** Mirror the Rust defense in depth; keep the independent legacy jev policy. */
export function scrubPresendCredentials(value: string): string {
  const withoutPem = value.replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g, OMITTED);
  return assignments(authorization(prefixes(withoutPem)));
}
