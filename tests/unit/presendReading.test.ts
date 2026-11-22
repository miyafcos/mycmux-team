// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { appendPresendLine, normalizePresendProvider, presendDraftFingerprint, presendWorkdirName, samePresendRevision, shouldReadPresend, unicodeTail, type PresendTrigger } from "../../src/lib/presendReading";
import { PRESEND_CREDENTIAL_KEYS, scrubJevCredentials, scrubPresendCredentials } from "../../src/lib/scrubCredentials";
import { useSettingsStore } from "../../src/stores/settingsStore";

const input: PresendTrigger = { enabled: true, tabEnabled: true, target: "claude", draft: "abcdefghijkl", composing: false, quietMs: 1500, attempted: new Set() };

describe("presend trigger and revisions", () => {
  it("allows another draft after an equal-length 32-bit fingerprint collision", () => {
    const first = "synthetic-8385cafbab8c";
    const second = "synthetic-0df01ab227f3";
    const attempted = new Set([presendDraftFingerprint(first)]);
    expect(first.length).toBe(second.length);
    expect(shouldReadPresend({ ...input, draft: second, attempted })).toBe(true);
  });

  it.each([
    { draft: "abcdefghijk" }, { draft: "a b c d e f g h i j k" }, { composing: true },
    { target: "shell" as const }, { enabled: false }, { tabEnabled: false }, { quietMs: 1499 },
    { attempted: new Set([presendDraftFingerprint(input.draft)]) },
  ])("skips an ineligible draft: %o", change => expect(shouldReadPresend({ ...input, ...change })).toBe(false));
  it("starts once at 1500ms, then refuses exactly the same text", () => {
    const attempted = new Set<string>();
    expect(shouldReadPresend({ ...input, attempted })).toBe(true);
    attempted.add(presendDraftFingerprint(input.draft));
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
  name: string; inputParts: string[]; expectedParts: string[]; jevParts: string[]; secret?: string;
}>;
describe("shared renderer and Rust credential examples", () => {
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
    expect(scrubPresendCredentials(input)).toBe(row.expectedParts.join(""));
    expect(scrubJevCredentials(input)).toBe(row.jevParts.join(""));
    expect(scrubPresendCredentials(row.expectedParts.join(""))).toBe(row.expectedParts.join(""));
  });
});
