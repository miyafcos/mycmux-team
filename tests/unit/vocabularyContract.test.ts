import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

interface Literal { file: string; line: number; text: string }
interface Exception { reason: string; file: RegExp; text: RegExp }

// ADR 0017 inherits these separate meanings. Keep exceptions exact enough
// that an unrelated old word in the same file/literal cannot be hidden.
const exceptions: Exception[] = [
  { reason: "Dashboard 2/3-pane labels describe panels, not sessions.", file: /^src\/components\/dashboard\//, text: /^(?:[23２３]\s*ペイン)(?:\s*[・/]\s*[23２３]\s*ペイン)?$/u },
  { reason: "Settings use their own navigation tabs.", file: /^src\/components\/settings\//, text: /^設定(?:画面|の)?タブ$/u },
  { reason: "Browser and child-webview tabs have their browser meaning.", file: /^src\/components\/(?:browser|web)\//, text: /^(?:ブラウザ|WebView)のタブ(?:グループ)?$/u },
];
// Fixed exact labels derived from approved UI judgments whose old terms include
// タブ and whose wording changed (REVIEW-RESPONSE-1 F03). Two shared spellings,
// タブを閉じる and このタブを閉じます, remain approved single-session labels.
const obsoleteContainerLabels = new Set([
  "${ws} › タブ${tab} › P${pane}",
  "1列あたりのタブ数が上限を超えています",
  "disposition=reorganize のグループは layout を必須にし、空の列・空のタブは禁止です。列は最大4、1列あたりタブは最大4です。",
  "layout のタブが不正です",
  "「${source.name}」の元のタブ",
  "このタブには実行中のエージェントペインが ${liveAgentTabs.length} 件あります。まとめて閉じますか？",
  "このタブのペインに追加",
  "このペインを閉じます（元の窓へ戻すには、この帯を掴んでタブのつまみ列へ）",
  "アクティブなタブを閉じる",
  "グループ ${group.groupId} の1列あたりタブ数が4を超えます",
  "グループ「${group.title}」に空のタブがあります",
  "タブ${tab}·P${pane}",
  "タブの左端・右端（完全再開）、下（引き継ぎ）、または「人に渡す」へドロップしてください。",
  "タブの最大化を切り替え",
  "タブや区切り",
  "タブを下に分割",
  "タブを右に分割",
  "タブを最大化",
  "タブを最大化 (${shortcut})",
  "タブを移動",
  "タブを統合",
  "タブ内の前のペイン",
  "タブ内の次のペイン",
  "タブ名が不正です",
  "タブ見出し（isPaneHead が true）は「領域 内容」の形にし、全角20文字以内にしてください。",
  "ドロップ先のペインまたはタブが変わったため、処理を中止しました。",
  "ペインはドラッグして移動先タブへ落とせます。",
  "ペインは閉じません。PTY も殺しません。配置（ワークスペース・タブ）だけを設計してください。",
  "ペインを選び、右の配置図の移動先タブをクリックします。",
  "ペインを選んで、右の配置図の移動先タブをクリックします",
  "レイアウトは列で分けます。1つの列にタブを2つ以上重ねてよいのは、上が親（母艦・指揮側）で下がその子（worker）のときだけです。それ以外は必ず列を増やしてください。タブを重ねた列が、その案の列数の3分の1を超えないようにしてください。",
  "上にタブ",
  "下にタブ",
  "元のワークスペースのタブ",
  "右にタブ",
  "同じ役割で関連の深いペインは、タブを分けず1つのタブの tabIds にまとめて裏ペインとして重ねてください。",
  "同じ領域に属する別タブは先頭語（領域）を共有してください。",
  "名前のないペインの画面末尾${TAB_NAMING_TAIL_LINES}行・作業フォルダ・タブ構成を ${target} に送って名前を付けます（自動で適用・元に戻せます）",
  "左にタブ",
  "既存タブの合流先が見つかりません: ",
  "既存タブへの合流先が不正です",
  "空きタブ",
  "空のタブは禁止です",
  "親子関係は階層で表現してください。親（母艦・指揮側）のタブを列の一番上に置き、子（worker）はその下のタブか、親と同じタブの裏ペインに入れてください。",
]);
const oldWords = /裏ペイン|ペイン|区画|つまみ/u;
const oldContainerWording = /タブを最大化|タブ内の(?:次|前)の|ワークスペース\s*>\s*タブ\s*>/u;

function codePoint(value: number): string {
  return String.fromCodePoint(value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) ? 0xfffd : value);
}

function decodeEntities(text: string): string {
  return text.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_match, hex: string, decimal: string) => codePoint(parseInt(hex ?? decimal, hex ? 16 : 10)));
}

function literals(file: string, source: string): Literal[] {
  if (file.endsWith(".html")) {
    const found: Literal[] = [];
    const clean = source.replace(/<!--[\s\S]*?-->/g, "");
    const markup = clean.replace(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_match, tag: string, body: string) => {
      found.push(...literals(file + (tag.toLowerCase() === "script" ? ".js" : ".css"), body).map(literal => ({ ...literal, file })));
      return "";
    });
    for (const match of markup.matchAll(/(?:\b[\w:-]+\s*=\s*(?:"([^"]*)"|'([^']*)'))|>([^<]+)</g)) {
      found.push({ file, line: markup.slice(0, match.index).split("\n").length, text: decodeEntities(match[1] ?? match[2] ?? match[3]) });
    }
    return found;
  }
  if (file.endsWith(".css")) {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
    const found: Literal[] = [];
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.StringLiteral) {
        // CSS uses hexadecimal escapes without a JS-style u prefix. Decode
        // the raw token so the JS scanner cannot reinterpret them as octal.
        const text = scanner.getTokenText().slice(1, -1).replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\r\f])|([\s\S]))/gi,
          (_match, hex: string, continuation: string, character: string) => hex ? codePoint(parseInt(hex, 16)) : continuation ? "" : character);
        found.push({ file, line: source.slice(0, scanner.getTokenPos()).split("\n").length, text });
      }
    }
    return found;
  }
  const syntax = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".jsx") ? ts.ScriptKind.JSX
    : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = file.endsWith(".json") ? ts.parseJsonText(file, source) : ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, syntax);
  const result: Literal[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node)) {
      // The approval table stores a complete template, while the ordinary
      // literal walk checks its decoded segments and nested expressions.
      const text = node.templateSpans.reduce((value, span) => value + "${" + span.expression.getText(tree) + "}" + span.literal.text, node.head.text);
      if (obsoleteContainerLabels.has(text)) {
        result.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, text });
      }
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const quotedAttribute = ts.isStringLiteral(node) && node.parent !== undefined && ts.isJsxAttribute(node.parent) && node.parent.initializer === node;
      result.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, text: ts.isJsxText(node) || quotedAttribute ? decodeEntities(node.text) : node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return result;
}

function violations(file: string, source: string): Literal[] {
  return literals(file, source).filter(literal => {
    const text = literal.text.replace(/スタブ|タブレット|タブー/gu, "");
    if (!oldWords.test(text) && !oldContainerWording.test(text) && !obsoleteContainerLabels.has(literal.text)) return false;
    return !exceptions.some(exception => exception.file.test(file) && exception.text.test(text.trim()));
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?|json|html|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("ADR 0017 UI vocabulary", () => {
  it("has no obsolete session/container wording in decoded src literals or JSX", () => {
    // A synthetic copied src tree can deliberately demonstrate contract failure.
    const root = resolve(process.env.VOCABULARY_CONTRACT_ROOT ?? process.cwd());
    const files = sourceFiles(join(root, "src"));
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap(file => violations(relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });

  it("decodes escapes and searches JSX/nested templates while ignoring comments", () => {
    const fixture = [
      "// ペイン in a comment",
      String.raw`const escaped = "\u30da\u30a4\u30f3";`,
      'const nested = `裏ペイン ${flag ? "ペイン" : "タブ"}`;',
      'const node = <div>区画{"つまみ"}</div>;',
      'const unrelated = "スタブ";',
    ].join("\n");
    expect(violations("src/example.tsx", fixture).map(literal => literal.text.trim())).toEqual(["ペイン", "裏ペイン", "ペイン", "区画", "つまみ"]);
    expect(violations("src/example.tsx", '<span>&#x30da;&#x30a4;&#x30f3;</span>')).toHaveLength(1);
  });

  it("rejects the old container meaning even when it contains only タブ", () => {
    expect(violations("src/example.ts", 'const label = "タブを最大化";')).toHaveLength(1);
    expect(violations("src/example.ts", 'const label = "このタブだけ表示";')).toEqual([]);
  });

  it.each([...obsoleteContainerLabels])("rejects the approved obsolete container label %s", (label) => {
    const source = label.includes("${") ? "const label = `" + label + "`;" : `const label = ${JSON.stringify(label)};`;
    expect(violations("src/example.ts", source).map(literal => literal.text)).toContain(label);
  });

  it("keeps legitimate single-session closing labels", () => {
    for (const label of ["このタブを閉じる", "このタブを閉じます", "タブを閉じる"]) {
      expect(violations("src/example.ts", `const label = ${JSON.stringify(label)};`)).toEqual([]);
    }
  });

  it.each([
    ["title", "&#x30da;&#x30a4;&#x30f3;"],
    ["title", "&#12506;&#12452;&#12531;"],
    ["aria-label", "&#x30da;&#x30a4;&#x30f3;"],
    ["aria-label", "&#12506;&#12452;&#12531;"],
  ])("decodes numeric entities in quoted JSX %s attributes: %s", (attribute, value) => {
    expect(violations("src/example.tsx", `<button ${attribute}="${value}" />`).map(literal => literal.text)).toEqual(["ペイン"]);
  });

  it("leaves HTML references literal inside JSX JavaScript expressions", () => {
    expect(violations("src/example.tsx", '<button title={"&#x30da;&#x30a4;&#x30f3;"} aria-label={"&#12506;&#12452;&#12531;"} />')).toEqual([]);
    expect(violations("src/example.ts", 'const label = "&#x30da;&#x30a4;&#x30f3;";')).toEqual([]);
  });

  it("checks JSON, HTML text/script/attributes and CSS content without their comments", () => {
    expect(violations("src/example.json", String.raw`{"label":"\u30da\u30a4\u30f3"}`)).toHaveLength(1);
    expect(violations("src/example.html", '<!-- ペイン --><b title="区画">&#x30da;&#x30a4;&#x30f3;</b><script>/* ペイン */ const label = "つまみ";</script>')).toHaveLength(3);
    expect(violations("src/example.css", '/* ペイン */ .label::after { content: "ペイン"; }')).toHaveLength(1);
    expect(violations("src/example.css", String.raw`.label::after { content: "\30da\30a4\30f3"; }`)).toHaveLength(1);
  });

  it("documents separate meanings and cannot exempt mixed old wording", () => {
    expect(exceptions.every(exception => exception.reason.trim().length > 0)).toBe(true);
    expect(violations("src/components/dashboard/example.ts", 'const label = "2ペイン";')).toEqual([]);
    expect(violations("src/components/dashboard/example.ts", 'const label = "2ペイン 区画";')).toHaveLength(1);
    expect(violations("src/example.ts", 'const label = "2ペイン";')).toHaveLength(1);
    expect(violations("src/components/settings/example.ts", 'const label = "タブの最大化を切り替え";')).toHaveLength(1);
    expect(violations("src/components/settings/example.ts", 'const label = "設定タブ 区画";')).toHaveLength(1);
    expect(violations("src/components/browser/example.ts", 'const label = "ブラウザのタブ 区画";')).toHaveLength(1);
    expect(violations("src/components/web/example.ts", 'const label = "Web タブを最大化";')).toHaveLength(1);
  });
});
