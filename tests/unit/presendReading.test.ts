// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendPresendLine, normalizePresendProvider, presendAttemptKey, presendWorkdirName, samePresendRevision, shouldReadPresend, unicodeTail, type PresendTrigger } from "../../src/lib/presendReading";
import { OMITTED, presendCredentialRanges, PRESEND_CREDENTIAL_KEYS, scrubJevCredentials, scrubPresendCredentials, scrubPresendReadingInput } from "../../src/lib/scrubCredentials";
import { useSettingsStore } from "../../src/stores/settingsStore";

const input: PresendTrigger = { enabled: true, tabEnabled: true, target: "claude", draft: "abcdefghijkl", composing: false, quietMs: 1500, attempted: new Set() };

describe("presend trigger and revisions", () => {
  it("allows another draft after an equal-length 32-bit fingerprint collision", () => {
    const first = "synthetic-8385cafbab8c";
    const second = "synthetic-0df01ab227f3";
    const attempted = new Set([presendAttemptKey(first, "claude")]);
    expect(first.length).toBe(second.length);
    expect(shouldReadPresend({ ...input, draft: second, attempted })).toBe(true);
  });

  it.each([
    { draft: "abcdefghijk" }, { draft: "a b c d e f g h i j k" }, { composing: true },
    { target: "shell" as const }, { enabled: false }, { tabEnabled: false }, { quietMs: 1499 },
    { attempted: new Set([presendAttemptKey(input.draft, "claude")]) },
  ])("skips an ineligible draft: %o", change => expect(shouldReadPresend({ ...input, ...change })).toBe(false));
  it("starts once at 1500ms, then refuses exactly the same text", () => {
    const attempted = new Set<string>();
    expect(shouldReadPresend({ ...input, attempted })).toBe(true);
    attempted.add(presendAttemptKey(input.draft, "claude"));
    expect(shouldReadPresend({ ...input, attempted, quietMs: 3000 })).toBe(false);
    expect(shouldReadPresend({ ...input, attempted, draft: `${input.draft}!` })).toBe(true);
    expect(shouldReadPresend({ ...input, draft: "\u3042".repeat(12) })).toBe(true);
  });
  it("discards changes of draft, version, tab, or provider", () => {
    const revision = { sessionId: "tab-a", draft: input.draft, target: "claude" as const, revision: 2, provider: "claude" as const };
    expect(samePresendRevision(revision, { ...revision })).toBe(true);
    for (const change of [{ revision: 3 }, { draft: "changed" }, { sessionId: "tab-b" }, { provider: "codex" as const }, { target: "shell" as const }]) {
      expect(samePresendRevision(revision, { ...revision, ...change })).toBe(false);
    }
  });
  it("appends visible conditions without a submit byte", () => {
    expect(appendPresendLine("draft", "missing", "folder")).toBe("draft\nfolder: ");
    expect(appendPresendLine("draft\n", "assumption", "local")).toBe("draft\n\u524d\u63d0: local");
  });
  it("uses only the working folder name and counts Unicode characters", () => {
    expect(presendWorkdirName("C:\\sample\\repo\\")).toBe("repo");
    expect(presendWorkdirName("/sample/repo/")).toBe("repo");
    expect(unicodeTail("a\ud83d\ude00b", 2)).toBe("\ud83d\ude00b");
  });
});

describe("presend privacy and compatibility", () => {
  it.each([
    ["sk-or-", "abcdefghijklmnop"].join(""), ["sk-proj-", "abcdefghijklmnop"].join(""), ["github_pat_", "abcdefghijklmnop"].join(""), ["ghp_", "abcdefghijklmnop"].join(""),
    ["sk-ant-", "abcdefghijklmnop"].join(""), ["xoxb-", "123456789012-abcdefgh"].join(""), ["xoxp-", "123456789012-abcdefgh"].join(""), ["AKIA", "1234567890ABCDEF"].join(""),
    ["-----BEGIN ", "PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"].join(""),
    ["-----BEGIN ", "RSA PRIVATE KEY-----\nsecret without end"].join(""),
  ])("redacts %s", secret => {
    expect(scrubPresendCredentials(`before ${secret} after`)).not.toContain(secret);
    expect(scrubPresendCredentials(secret)).toBe("[credential omitted]");
  });
  it.each(["password=secret", "token=secret", "PASSWORD = \"two words\"", "Token='two words'", "token=a&next=safe", "access_token=secret", "db_password='two words'"]) (
    "redacts assignment values: %s", text => {
      const redacted = scrubPresendCredentials(text);
      expect(redacted).toContain("[credential omitted]");
      expect(redacted).not.toMatch(/secret|two words|=a&/);
    },
  );
  it("preserves the previous jev policy byte for byte, including its narrower scope", () => {
    const legacy = (text: string) => text.replace(/(?:sk-or-|sk-proj-|github_pat_|ghp_)[A-Za-z0-9_-]{12,}/g, "[credential omitted]")
      .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g, "[credential omitted]");
    const cases = ["ordinary text", ["sk-proj-", "abcdefghijklmnop xoxb-12345 token=secret"].join(""), ["-----BEGIN ", "PRIVATE KEY-----\nsecret"].join(""), "ghp_short", ["github_pat_", "abcdefghijklmnop"].join("")];
    for (const text of cases) expect(scrubJevCredentials(text)).toBe(legacy(text));
  });
  it("scrubs before clipping the reply tail", () => {
    const secret = "sk-ant-" + "a".repeat(1700);
    expect(unicodeTail(scrubPresendCredentials(secret), 1500)).toBe("[credential omitted]");
  });
  it("merges older saved settings into the opt-in defaults", () => {
    const initial = useSettingsStore.getInitialState();
    const merged = useSettingsStore.persist.getOptions().merge!({ paneComposerEnabled: true }, initial);
    expect(merged.presendReadingEnabled).toBe(false);
    expect(merged.presendReadingProvider).toBe("claude");
    expect(useSettingsStore.persist.getOptions().merge!({ presendReadingEnabled: "true", presendReadingProvider: "other" }, initial).presendReadingEnabled).toBe(false);
    expect(normalizePresendProvider("unknown")).toBe("claude");
    expect(normalizePresendProvider("codex")).toBe("codex");
  });
});

const credentialFixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/presend_credentials.json"), "utf8"));
const workdirCases = credentialFixture.workdirCases as Array<{ name: string; input: string; expected: string }>;
it.each(workdirCases)("normalizes the workdir: $name", ({ input, expected }) => {
  expect(presendWorkdirName(input)).toBe(expected);
});

const credentialCases = credentialFixture.cases as Array<{
  name: string; inputParts: string[]; expectedParts: string[]; jevParts: string[]; rescrubParts?: string[]; secret?: string;
}>;
describe("shared renderer and Rust credential examples", () => {

  const counter = credentialCases.find(row => row.name === "0915-L5-fix2-19-counter-numeric")!;
  const sampleValue = credentialCases.find(row => row.name === "0915-L5-119-nonnumeric-token-counter")!.secret!;

  it("masks the numeric fixture's whole end comment on the second and third pass", () => {
    const raw = counter.inputParts.join("");
    const first = scrubPresendCredentials(raw);
    const second = scrubPresendCredentials(first);
    const third = scrubPresendCredentials(second);
    expect([raw, first, second, third].map(text => Buffer.byteLength(text))).toEqual([80, 155, 138, 138]);
    expect(second === counter.rescrubParts!.join("") && third === second).toBe(true);
  });

  it("masks the whole numeric end comment containing independent protected values", () => {
    const prefixed = credentialCases.find(row => row.name.startsWith("prefix-") && row.expectedParts.join("") === OMITTED)!;
    const field = "token_count: " + OMITTED;
    const input = field + " \t# ordinary note " + prefixed.inputParts.join("") + " password=" + sampleValue;
    const second = scrubPresendCredentials(input);
    expect(second === field && scrubPresendCredentials(second) === field).toBe(true);
  });

  const contexts: Record<string, string> = JSON.parse(readFileSync(
    resolve(import.meta.dirname, "../fixtures/presend_comment_contexts.json"), "utf8",
  ));
  it.each(Object.entries(contexts))("masks the end comment on later passes in %s", (_name, document) => {
    const line = counter.inputParts.join("").split("\n").at(-1)!;
    const [field, note] = line.split("# ");
    const observed = [note, sampleValue].map(value => {
      const first = scrubPresendCredentials(document.replace("{counter}", field + "# " + value));
      const second = scrubPresendCredentials(first);
      const third = scrubPresendCredentials(second);
      return [first.includes(value), second.includes(value), third.includes(value), third === second];
    });
    expect(observed).toEqual([[true, false, false, true], [true, false, false, true]]);
  });

  it.each(["v0.90.14", "L5"] as const)("covers all %s mask ranges on the original input", policy => {
    const history = credentialFixture.historicalByteRanges as Record<string, [number[][], number[][]]>;
    expect(Object.keys(history)).toHaveLength(credentialCases.length);
    for (const row of credentialCases) {
      const input = row.inputParts.join("");
      const actual = presendCredentialRanges(input).map(({ start, end }) =>
        [Buffer.byteLength(input.slice(0, start)), Buffer.byteLength(input.slice(0, end))]);
      for (const [start, end] of history[row.name][policy === "v0.90.14" ? 0 : 1]) {
        expect(actual.some(([lo, hi]) => lo <= start && end <= hi),
          row.name + " bytes " + start + ".." + end).toBe(true);
      }
    }
  });

  it("bounds character checks for overlong AWS-like uppercase input", () => {
    const input = "AKIA".repeat(400) + "Z";
    const regexTest = RegExp.prototype.test;
    let uppercaseChecks = 0;
    const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value) {
      if (this.source === "[A-Z0-9]") uppercaseChecks++;
      return regexTest.call(this, value);
    });
    let output: string;
    try {
      output = scrubPresendCredentials(input);
    } finally {
      spy.mockRestore();
    }
    expect(output).toBe(input);
    expect(uppercaseChecks).toBeLessThan(input.length * 5);
  });

  it("bounds line-break checks in a long credential query", () => {
    const query = "https://example.test/?" + Array.from({ length: 160 }, (_, i) => `token=toy-${i}&mode=demo`).join("&");
    const regexTest = RegExp.prototype.test;
    let checks = 0;
    const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value) {
      if (this.source === String.raw`[\n\r\u2028\u2029]`) checks++;
      return regexTest.call(this, value);
    });
    let output: string;
    try {
      output = scrubPresendCredentials(query);
    } finally {
      spy.mockRestore();
    }
    expect(output).toBe(query.slice(0, query.indexOf("=") + 1) + "[credential omitted]");
    expect(checks).toBeLessThan(query.length * 5);
  });

  it("fixes five case forms for every credential key in the implementation table", () => {
    expect(credentialFixture.credentialKeys).toEqual(PRESEND_CREDENTIAL_KEYS);
    for (const key of PRESEND_CREDENTIAL_KEYS) {
      const forms = [key, key.toUpperCase(), key[0].toUpperCase() + key.slice(1),
        key[0] + key[1].toUpperCase() + key.slice(2),
        [...key].map((c, i) => i % 2 === 0 ? c.toUpperCase() : c).join("")];
      forms.forEach((form, i) => {
        const row = credentialCases.find(row => row.name === `credential-key-case-${key}-${i}`)!;
        expect(row.inputParts.join("")).toBe(`${form}=demo-value`);
        expect(row.expectedParts.join("")).toBe(`${form}=[credential omitted]`);
      });
    }
  });
  it("keeps every base credential match in the shared assignment name table", () => {
    const matchesParts = (name: string) => {
      const parts = name.toLowerCase().split(/[_-]/);
      return parts.some((part, i) => credentialFixture.credentialKeys.includes(part)
        || credentialFixture.credentialKeys.includes(`${part}_${parts[i + 1]}`));
    };
    const names = credentialCases.flatMap(row => {
      const match = /^([A-Za-z0-9_-]+)=demo-value$/.exec(row.inputParts.join(""));
      return match ? [match[1]] : [];
    });
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      const baseMatch = matchesParts(name) || matchesParts(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
      if (baseMatch) {
        expect(scrubPresendCredentials(`${name}=demo-value`), name).toBe(`${name}=[credential omitted]`);
      }
    }
  });
  it("redacts the synthetic authorization secrets in the fb1363b54 comparison", () => {
    let checked = 0;
    for (const { name, inputParts, secret } of credentialCases) {
      if (secret === undefined) continue;
      const input = inputParts.join("");
      expect(input, name).toContain(secret);
      expect(scrubPresendCredentials(input), name).not.toContain(secret);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(14);
  });
  it.each(credentialCases)("$name", row => {
    const input = row.inputParts.join("");
    const expected = row.expectedParts.join("");
    const second = row.rescrubParts?.join("") ?? expected;
    expect(scrubPresendCredentials(input) === expected, row.name).toBe(true);
    expect(scrubJevCredentials(input) === row.jevParts.join(""), row.name).toBe(true);
    expect(scrubPresendCredentials(expected) === second, row.name).toBe(true);
    expect(scrubPresendCredentials(second) === second, row.name).toBe(true);
  });
});

it("redacts values after decoding escapes in quoted field names", () => {
  for (const key of [
    String.raw`"\u0070assword"`, String.raw`'pass\x77ord'`,
    String.raw`"pass\word"`, String.raw`"authoriz\u0061tion"`,
    String.raw`"\uD83D\uDE42_password"`,
  ]) {
    expect(scrubPresendReadingInput(key + ': "dummy-field-value"')).toBe(key + ': "' + OMITTED + '"');
  }
  const prefix = ["sk-ant-", "fixture-key_"].join("");
  const key = String.raw`"\u0070assword_` + prefix + '"';
  expect(scrubPresendReadingInput(key + ': "dummy-field-value"')).toBe(
    String.raw`"\u0070assword_` + OMITTED + '": "' + OMITTED + '"',
  );
});

it("stops reading YAML when a node property and a credential belong to the same node", () => {
  const cases = [
    'creds: &toy\n  "' + String.raw`\u0070assword` + '": dummy-value',
    "creds: {password: *toy}",
    "creds: !toy {password: dummy-value}",
    "? password\n: dummy-value",
    "?\n  - password\n: dummy-value",
  ];
  for (const value of cases) expect(scrubPresendReadingInput(value), value).toBeNull();

  const separateNodes = "sample: &toy\n  label: hello\npassword: dummy-value";
  expect(scrubPresendReadingInput(separateNodes)).toBe("sample: &toy\n  label: hello\npassword: " + OMITTED);
  const separateFlow = 'sample: [&toy hello, {password: "dummy-value"}]';
  expect(scrubPresendReadingInput(separateFlow)).toBe('sample: [&toy hello, {password: "' + OMITTED + '"}]');
});

it("stops reading when a YAML alias resolves to a credential field name", () => {
  for (const name of ["password", '"\\u0070assword"']) {
    for (const key of ["? *sample-key\n:", "*sample-key :"]) {
      const input = "field-name: &sample-key " + name + "\n" + key + " dummy-field-value";
      expect(scrubPresendReadingInput(input)).toBeNull();
    }
  }
  for (const ordinary of [
    "field-name: &sample-key theme\n? *sample-key\n: rename the password label",
    "old-name: &sample-key password\nnew-name: &sample-key theme\n? *sample-key\n: rename the label",
    "? &password theme\n: rename the label",
  ]) expect(scrubPresendReadingInput(ordinary)).toBe(ordinary);
});

it("lane F leaves an ordinary escaped environment name readable", () => {
  const input = '{"name":"SAMPLE\\u005fTHEME","value":"dark"}';
  expect(scrubPresendReadingInput(input)).toBe(input);
});

it.each([
  ["plain note with a mid-value quote (name first)", "env: [{name: API_TOKEN, note: say \"hello, value: fixture-label}]", "env: [{name: API_TOKEN, note: say \"hello, value: [credential omitted]}]"],
  ["quoted note with a delimiter (name first)", "env: [{name: API_TOKEN, note: \"say, hello\", value: fixture-label}]", "env: [{name: API_TOKEN, note: \"say, hello\", value: [credential omitted]}]"],
  ["an unterminated quoted note (name first)", "env: [{name: API_TOKEN, note: \"unfinished, value: fixture-label}]", null],
  ["plain note with a mid-value quote (value first)", "env: [{value: fixture-label, note: say \"hello, name: API_TOKEN}]", "env: [{value: [credential omitted], note: say \"hello, name: API_TOKEN}]"],
  ["quoted note with a delimiter (value first)", "env: [{value: fixture-label, note: \"say, hello\", name: API_TOKEN}]", "env: [{value: [credential omitted], note: \"say, hello\", name: API_TOKEN}]"],
  ["an unterminated quoted note (value first)", "env: [{value: fixture-label, note: \"unfinished, name: API_TOKEN}]", null],
] as const)("G2-001 checks %s before reading", (_label, input, expected) => {
  expect(scrubPresendReadingInput(input)).toBe(expected === undefined ? input : expected);
});

it.each([
  ["tagged neighbor and a comment on a structured value", "cfg: {a: !t [1] # note\n , password: {p: alpha # }\n  , q: fixture-label}}", null],
  ["tagged neighbor and a multiline plain value", "cfg: {a: !t [1] # note\n , password: alpha\n    fixture-label, mode: demo}", null],
  ["a closing bracket in a sequence comment", "cfg: {password: [alpha # ]\n    , fixture-label], mode: demo}", null],
  ["a completely covered flow value", "cfg: {password: {p: alpha, q: fixture-label}, mode: demo}", "cfg: {password: [credential omitted], mode: demo}"],
  ["a split record whose value continues (name first)", "env: [{name: API_TOKEN, value: [alpha # ]\n    , fixture-label]}]", null],
  ["a split record whose value continues (value first)", "env: [{value: [alpha # ]\n    , fixture-label], name: API_TOKEN}]", null],
] as const)("G2-002 checks %s before reading", (_label, input, expected) => {
  expect(scrubPresendReadingInput(input)).toBe(expected === undefined ? input : expected);
});

it.each([
  ["flow PATH after a leading comment (name first)", "env: [{name: # search path\n \n PATH, value: /usr/bin}]", undefined],
  ["deep block PATH after a leading comment (name first)", "env:\n  - name: # search path\n\n        PATH\n    value: fixture-label", undefined],
  ["flow credential name after a comment (name first)", "env: [{name: # setting\n API_TOKEN, value: /usr/bin}]", "env: [{name: # setting\n API_TOKEN, value: [credential omitted]}]"],
  ["deep block credential name after a comment (name first)", "env:\n  - name: # setting\n\n        API_TOKEN\n    value: fixture-label", "env:\n  - name: # setting\n\n        API_TOKEN\n    value: [credential omitted]"],
  ["block comment followed by a same-depth key (name first)", "env:\n  - name: # intentionally blank\n    value: fixture-label", null],
  ["flow PATH after a leading comment (value first)", "env: [{value: /usr/bin, name: # search path\n \n PATH}]", undefined],
  ["deep block PATH after a leading comment (value first)", "env:\n  - value: fixture-label\n    name: # search path\n\n        PATH", undefined],
  ["flow credential name after a comment (value first)", "env: [{value: /usr/bin, name: # setting\n API_TOKEN}]", "env: [{value: [credential omitted], name: # setting\n API_TOKEN}]"],
  ["deep block credential name after a comment (value first)", "env:\n  - value: fixture-label\n    name: # setting\n\n        API_TOKEN", "env:\n  - value: [credential omitted]\n    name: # setting\n\n        API_TOKEN"],
  ["block comment followed by a same-depth key (value first)", "env:\n  - value: fixture-label\n    name: # intentionally blank", null],
] as const)("G2-003 checks %s before reading", (_label, input, expected) => {
  expect(scrubPresendReadingInput(input)).toBe(expected === undefined ? input : expected);
});

it.each([
  ["an empty middle member (name first)", "env:\n  - name:\n    note:\n    value: fixture-label", null],
  ["adjacent members (name first)", "env:\n  - name:\n    value: fixture-label", null],
  ["an empty middle member (value first)", "env:\n  - value: fixture-label\n    note:\n    name:", null],
  ["adjacent members (value first)", "env:\n  - value: fixture-label\n    name:", null],
] as const)("G2-004 checks %s before reading", (_label, input, expected) => {
  expect(scrubPresendReadingInput(input)).toBe(expected === undefined ? input : expected);
});

it("lane F omits input when an alias key refers to an uncertain YAML name", () => {
  for (const node of [
    "|-\n  password",
    ">-\n  password",
    "[theme, language]",
    '"two\n  lines"',
    "theme # heading\n  continuation",
  ]) {
    for (const key of ["? *sample-key\n:", "*sample-key :"]) {
      const input = "field-name: &sample-key " + node + "\n" + key + " fixture-label";
      expect(scrubPresendReadingInput(input), node + " / " + key).toBeNull();
    }
    const notUsedAsKey = "field-name: &sample-key " + node + "\nlabel: fixture-label";
    expect(scrubPresendReadingInput(notUsedAsKey)).toBe(notUsedAsKey);
  }
});
