"""Browser functions that only work with the window as `this` are never stored uncalled.

The grouping precompute coordinator and the pane naming scheduler call their
timers as methods -- `dependencies.clearTimer(timer)`, `deps.setInterval(...)`.
WebView2 throws "Illegal invocation" when a window function such as
clearTimeout runs with any other `this`, while Node's timers accept any
receiver. So every unit test passed while v0.80.1 (a `setTimeout, clearTimeout`
shorthand) never showed its window and v0.80.2 (`clearTimer: clearTimeout`)
broke drag and drop. Such a function is stored behind an arrow
(`timer => clearTimeout(timer)`) or bound (`clearTimeout.bind(globalThis)`).

This is a scanner, not a parser. It reads each file once to empty comments,
strings, template literals, regular expressions and import statements, matches
the brackets of what is left, and then looks for the two shapes both defects
had:

- shape 1, a value: the function right after `:` `=` `??` `||` -- on the same
  line or the next -- with nothing after it but a separator, the end of the
  file or the next statement (a TypeScript `!`, `as` or `satisfies` in between
  counts as nothing);
- shape 2, object shorthand: the bare name as a whole element of `{ ... }`, or
  a line that is nothing but a comma-separated list of names.

Calls, wrappers, types, comments, string contents and import lists hold no
value. Nor do destructuring patterns and parameter lists: `const { fetch } =
api` and `({ fetch }) => ...` bind a local name and store no window function.
The exception is a pattern read straight off the window --
`const { clearTimeout } = window` stores the window's own function as surely as
`const clear = window.clearTimeout` does.
"""

from __future__ import annotations

import bisect
import re
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"

RECEIVER_SENSITIVE = (
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "requestIdleCallback",
    "cancelIdleCallback",
    "queueMicrotask",
    "fetch",
    "reportError",
    "getComputedStyle",
    "matchMedia",
)

FIX_HINT = "矢印で包むか .bind(globalThis) を付ける (例: clearTimer: timer => clearTimeout(timer))"

_NAMES = "|".join(RECEIVER_SENSITIVE)
_NAME = r"(?:(?:window|globalThis|self)\s*\.\s*)?(?:" + _NAMES + r")(?![\w$])"
# `=` alone, not part of `==`, `!=`, `<=`, `>=` or `=>`.
_VALUE_OPERATOR = r"(?P<operator>\?\?|\|\||(?<![=!<>])=(?![=>])|:)"
# Where a value that is only a name ends: at a separator, a TypeScript `!` / `as` / `satisfies`,
# the end of the file, or a line break before the next statement (automatic semicolon insertion).
# `fetch` followed by `.then(...)` or `(url)` on the next line goes on, so it does not end there.
_VALUE_END = (
    r"(?=\s*!?\s*(?:(?:as|satisfies)\b|[,;)}\]]|\Z)"
    r"|[ \t]*\n\s*(?!(?:as|satisfies|in|instanceof)\b)[A-Za-z_$])"
)

# Shape 1, over the whole file so the value may sit on the line after its operator:
# `clearTimer: clearTimeout,` / `const raf = window.requestAnimationFrame;` / `a ?? fetch)`
VALUE_POSITION = re.compile(_VALUE_OPERATOR + r"\s*(?P<name>" + _NAME + r")" + _VALUE_END)
# A destructuring pattern whose right-hand side is exactly `window`, `globalThis` or `self`.
_FROM_THE_WINDOW = re.compile(r"\s*(?::[^=;]*)?=(?![=>])\s*(?:window|globalThis|self)(?![\w$])" + _VALUE_END)
# Shape 2: a bare name, to be checked against the brackets around it, and a line of names such as
#   `    setTimeout, clearTimeout, setInterval, clearInterval,`
_BARE_NAME = re.compile(r"(?<![\w$.])(?:" + _NAMES + r")(?![\w$])")
_LIST_LINE = re.compile(r"^(?:[A-Za-z_$][\w$.]*\s*,\s*)*[A-Za-z_$][\w$.]*\s*,?$")
_LIST_ENTRY = re.compile(r"^" + _NAME + r"$")

# An import or export-list statement up to its end -- not `import.meta` or `import(...)`. That is
# the first `;` on its line or, after the `}` of a list (which may run over lines), the
# ` from "..."` and its `;`. Code after the end on the same line is read.
_IMPORT_STATEMENT = re.compile(
    r"^[ \t]*(?:import(?=[\s{*\"'])|export\s+(?:type\s+)?(?=\{))[^;{\n]*(?:\{[^}]*\}[^;\n]*)?;?",
    re.MULTILINE,
)

_WORD = re.compile(r"[\w$]+")
# After one of these words a `/` starts a regular expression, not a division.
_WORDS_BEFORE_A_VALUE = frozenset({
    "return", "typeof", "case", "do", "else", "in", "instanceof", "new", "delete",
    "void", "throw", "yield", "await", "of",
})


def _value_expected(previous: str) -> bool:
    """Whether a `/` right after the token `previous` starts a regular expression."""
    if not previous or previous in _WORDS_BEFORE_A_VALUE:
        return True
    return not (previous[-1].isalnum() or previous[-1] in "_$)]\"'`")


def _regular_expression_end(line: str, start: int) -> int | None:
    """Where the regular expression opened by the `/` at `start` ends, or None if not on this line."""
    i = start + 1
    in_class = False
    while i < len(line):
        char = line[i]
        if char == "\\":
            i += 2
            continue
        if in_class:
            in_class = char != "]"
        elif char == "[":
            in_class = True
        elif char == "/":
            i += 1
            while i < len(line) and line[i].isalpha():
                i += 1
            return i
        i += 1
    return None


def _lex(text: str) -> list[str]:
    """The lines of `text` with comments, strings, template literals and regular expressions emptied.

    One pass over the whole file, because a block comment and a template literal
    run on across lines. The `${...}` parts of a template are followed as code, so
    the template ends where it really ends even with another template nested in
    them, but nothing inside a template is kept. A `/` opens a regular expression
    where a value is expected (after an operator, `(`, `,`, `return` ...), so a
    quote or a backtick inside one, as in /^```/u, opens nothing.
    """
    lexed: list[str] = []
    # One entry per open template, innermost last: -1 inside its text, or the
    # brace depth inside one of its `${...}` parts.
    templates: list[int] = []
    in_block_comment = False
    previous = ""
    for line in text.splitlines():
        out: list[str] = []
        i = 0
        while i < len(line):
            if in_block_comment:
                end = line.find("*/", i)
                if end < 0:
                    break
                i = end + 2
                in_block_comment = False
                continue
            char = line[i]
            if templates and templates[-1] < 0:
                if char == "\\":
                    i += 2
                elif char == "`":
                    templates.pop()
                    i += 1
                    previous = "`"
                    if not templates:
                        out.append("`")
                elif line.startswith("${", i):
                    templates[-1] = 0
                    i += 2
                    previous = "{"
                else:
                    i += 1
                continue
            keep = not templates
            if char.isspace():
                if keep:
                    out.append(char)
                i += 1
            elif line.startswith("//", i):
                break
            elif line.startswith("/*", i):
                in_block_comment = True
                i += 2
            elif char in "\"'":
                i += 1
                while i < len(line) and line[i] != char:
                    i += 2 if line[i] == "\\" else 1
                i += 1
                if keep:
                    out.append(char * 2)
                previous = char
            elif char == "`":
                if keep:
                    out.append("`")
                templates.append(-1)
                i += 1
            elif char == "/" and _value_expected(previous) and (end := _regular_expression_end(line, i)):
                if keep:
                    out.append('""')
                i = end
                previous = '"'
            elif word := _WORD.match(line, i):
                if keep:
                    out.append(word.group())
                previous = word.group()
                i = word.end()
            else:
                if templates and char == "{":
                    templates[-1] += 1
                elif templates and char == "}":
                    templates[-1] -= 1  # at -1 the `${...}` part is over: back in the template text
                if keep:
                    out.append(char)
                previous = char
                i += 1
        lexed.append("".join(out))
    return lexed


def _code(text: str) -> list[str]:
    """Every line of `text` as code, with comments, strings and import statements left out.

    Module bindings are not stored values, so an import statement is emptied up to its end;
    line breaks stay where they were, so every line keeps its number.
    """
    code = "\n".join(_lex(text))
    code = _IMPORT_STATEMENT.sub(lambda match: re.sub(r"[^\n]", " ", match.group()), code)
    return code.split("\n")


def code_lines(text: str):
    """Yields (line number, code) for the lines of `text` that still hold code."""
    for index, line in enumerate(_code(text)):
        if line.strip():
            yield index + 1, line


def _previous_character(code: str, position: int) -> str:
    index = position - 1
    while index >= 0 and code[index].isspace():
        index -= 1
    return code[index] if index >= 0 else ""


def _next_character(code: str, position: int) -> str:
    index = position
    while index < len(code) and code[index].isspace():
        index += 1
    return code[index] if index < len(code) else ""


_OPENERS = {")": "(", "]": "[", "}": "{"}
_DECLARED_BEFORE = re.compile(r"(?<![\w$.])(?:const|let|var)\s*$")
_ASSIGNED_AFTER = re.compile(r"\s*=(?![=>])")
_ARROW_AFTER = re.compile(r"\s*(?::[^;{}()=\n]*)?=>")
_BODY_AFTER = re.compile(r"\s*(?::[^;{}()=\n]*)?\{")
_FUNCTION_BEFORE = re.compile(r"(?<![\w$.])function\b[\s*]*[\w$]*\s*(?:<[^()]*>)?\s*$")
_NAME_BEFORE = re.compile(r"(?<![\w$.])([\w$]+)\s*(?:<[^()]*>)?\s*$")
_NOT_A_FUNCTION_NAME = frozenset({
    "if", "for", "while", "switch", "catch", "with", "return", "typeof", "new", "await",
    "void", "delete", "throw", "case", "in", "of", "do", "else", "yield", "instanceof",
})


class _Brackets:
    """The matched brackets of a file's code, and which of them bind names rather than hold values."""

    def __init__(self, code: str) -> None:
        self.code = code
        self.groups: list[list] = []  # [opened at, closed at or None, "(" / "[" / "{", parent or -1]
        self.positions: list[int] = []  # every bracket that took effect, in order
        self.owners: list[int] = []  # the group that holds the code right after that bracket
        stack: list[int] = []
        for match in re.finditer(r"[()\[\]{}]", code):
            position, char = match.start(), match.group()
            if char in "([{":
                self.groups.append([position, None, char, stack[-1] if stack else -1])
                stack.append(len(self.groups) - 1)
            else:
                # A stray bracket, such as a smiley in JSX text, closes the nearest opener of its kind.
                depth = len(stack) - 1
                while depth >= 0 and self.groups[stack[depth]][2] != _OPENERS[char]:
                    depth -= 1
                if depth < 0:
                    continue
                self.groups[stack[depth]][1] = position
                del stack[depth:]
            self.positions.append(position)
            self.owners.append(stack[-1] if stack else -1)
        self._patterns: dict[int, bool] = {}
        self._parameter_lists: dict[int, bool] = {}

    def owner(self, position: int) -> int:
        """The innermost group around the character at `position` (not a bracket itself), or -1."""
        index = bisect.bisect_right(self.positions, position) - 1
        return self.owners[index] if index >= 0 else -1

    def kind(self, group: int) -> str:
        return self.groups[group][2] if group >= 0 else ""

    def binds_names(self, group: int) -> bool:
        """A destructuring pattern or a parameter list: the names in it are declared, not stored."""
        kind = self.kind(group)
        return (kind in ("{", "[") and self.is_pattern(group)) or (kind == "(" and self.is_parameter_list(group))

    def is_pattern(self, group: int) -> bool:
        if group not in self._patterns:
            opened, closed, kind, parent = self.groups[group]
            before = self.code[max(0, opened - 80):opened]
            after = self.code[closed + 1:closed + 81] if closed is not None else ""
            previous = _previous_character(self.code, opened)
            pattern = False
            if kind in ("{", "["):
                if _DECLARED_BEFORE.search(before) or _ASSIGNED_AFTER.match(after):
                    pattern = True  # `const { fetch } = api` / `({ fetch } = api)`
                elif self.kind(parent) in ("{", "[") and previous != "=":
                    pattern = self.is_pattern(parent)  # `{ a: { fetch } }` inside a pattern, not a default
                elif self.kind(parent) == "(" and previous in ("(", ","):
                    pattern = self.is_parameter_list(parent)  # `({ fetch }) =>`
            self._patterns[group] = pattern
        return self._patterns[group]

    def is_parameter_list(self, group: int) -> bool:
        if group not in self._parameter_lists:
            opened, closed, kind, _parent = self.groups[group]
            parameters = False
            if kind == "(" and closed is not None:
                before = self.code[max(0, opened - 160):opened]
                after = self.code[closed + 1:closed + 161]
                if _ARROW_AFTER.match(after) or _FUNCTION_BEFORE.search(before):
                    parameters = True
                else:
                    # A method definition: `run({ setTimeout }): void {`, never `if (...) {`.
                    name = _NAME_BEFORE.search(before)
                    parameters = bool(
                        name and name.group(1) not in _NOT_A_FUNCTION_NAME and _BODY_AFTER.match(after)
                    )
            self._parameter_lists[group] = parameters
        return self._parameter_lists[group]


def stored_uncalled(text: str) -> list[tuple[int, str]]:
    """Every line that keeps a receiver-sensitive browser function as a value, as written."""
    raw_lines = text.splitlines()
    lines = _code(text)
    starts: list[int] = []
    offset = 0
    for line in lines:
        starts.append(offset)
        offset += len(line) + 1
    code = "\n".join(lines)
    brackets = _Brackets(code)

    def line_of(position: int) -> int:
        return bisect.bisect_right(starts, position) - 1

    found: set[int] = set()
    # Shape 1, reported on the line that holds the name.
    for match in VALUE_POSITION.finditer(code):
        # In `const { timer: setTimeout } = options` the `:` names a local; nothing is stored.
        group = brackets.owner(match.start("operator"))
        if match.group("operator") == ":" and brackets.kind(group) in ("{", "[") and brackets.is_pattern(group):
            continue
        found.add(line_of(match.start("name")))
    # Shape 2, a line of names -- unless it lists the names a pattern or a parameter list declares.
    for index, line in enumerate(lines):
        stripped = line.strip()
        listed = _LIST_LINE.match(stripped) is not None and any(
            _LIST_ENTRY.match(entry.strip()) for entry in stripped.split(",") if entry.strip()
        )
        if listed and not brackets.binds_names(brackets.owner(starts[index] + len(line) - len(line.lstrip()))):
            found.add(index)
    # Shape 2, shorthand: a bare name that is a whole element of an object literal.
    for match in _BARE_NAME.finditer(code):
        group = brackets.owner(match.start())
        if brackets.kind(group) != "{" or brackets.is_pattern(group):
            continue
        if _previous_character(code, match.start()) in ("{", ",") and _next_character(code, match.end()) in (",", "}"):
            found.add(line_of(match.start()))
    # A pattern read straight off the window: a name in it that is a key -- shorthand, renamed
    # (`fetch: load`) or defaulted (`fetch = f`) -- takes the window's own function.
    for group, (opened, closed, kind, _parent) in enumerate(brackets.groups):
        if kind != "{" or closed is None or not _FROM_THE_WINDOW.match(code, closed + 1):
            continue
        for match in _BARE_NAME.finditer(code, opened + 1, closed):
            if (brackets.owner(match.start()) == group
                    and _previous_character(code, match.start()) in ("{", ",")
                    and _next_character(code, match.end()) in (",", "}", ":", "=")):
                found.add(line_of(match.start()))
    return [(index + 1, raw_lines[index].strip()) for index in sorted(found)]


# The two lines that shipped: src/lib/autoPaneNaming.ts:64 in v0.80.1 and
# src/lib/groupingPrecompute.ts:206 in v0.80.2.
V0801_AUTO_PANE_NAMING_64 = "    setTimeout, clearTimeout, setInterval, clearInterval,"
V0802_GROUPING_PRECOMPUTE_206 = (
    "    now: Date.now, setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: clearTimeout,"
)


def test_scanner_catches_both_shipped_defects() -> None:
    assert stored_uncalled(V0801_AUTO_PANE_NAMING_64) == [(1, V0801_AUTO_PANE_NAMING_64.strip())]
    assert stored_uncalled(V0802_GROUPING_PRECOMPUTE_206) == [(1, V0802_GROUPING_PRECOMPUTE_206.strip())]


@pytest.mark.parametrize(
    "line",
    [
        "const timers = { setTimeout, clearTimeout };",
        "  return { now: Date.now, setTimeout };",
        "const raf = window.requestAnimationFrame;",
        "  clearTimer: globalThis.clearTimeout,",
        "  clearTimer: clearTimeout as (timer: number) => void,",
        "const schedule = options.schedule ?? queueMicrotask;",
        "const load = injected || fetch;",
        "  clearTimeout",
        # A call in an earlier element does not hide the shorthand after it.
        "const timers = { fallback: makeTimer(), clearTimeout };",
        # An object literal handed to a call or given as a default still stores the function.
        "createScheduler({ setTimeout, clearTimeout });",
        "function run(options = { setTimeout }) {",
        "const make = () => ({ setTimeout });",
    ],
)
def test_scanner_catches_other_uncalled_shapes(line: str) -> None:
    assert stored_uncalled(line) == [(1, line.strip())]


@pytest.mark.parametrize(
    "line",
    [
        "const handle = setTimeout(fn, 1);",
        "  setTimer: (cb, ms) => setTimeout(cb, ms),",
        "  clearTimer: timer => clearTimeout(timer),",
        "  clearTimeout: globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout,",
        "const requestFrame = options.requestFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);",
        "type TimerHandle = ReturnType<typeof setTimeout>;",
        "  setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout;",
        "  setTimeout?: (handler: () => void, delayMs: number) => unknown;",
        "  fetch: async () => {",
        "  reportError: (message) => useToastStore.getState().pushToast(message, \"error\"),",
        "if (typeof window === \"undefined\" || !window.matchMedia) return;",
        "if (fn === setTimeout) return;",
        "    // bare `clearTimer: clearTimeout` made the rearrangement button throw",
        "const message = \"clearTimer: clearTimeout,\";",
    ],
)
def test_scanner_ignores_calls_wrappers_types_and_comments(line: str) -> None:
    assert stored_uncalled(line) == []


@pytest.mark.parametrize(
    "line",
    [
        "const { fetch } = api;",
        "({ fetch } = api);",
        "const { timer: setTimeout } = options;",
        "for (const { fetch } of sources) {",
        "function run({ setTimeout }) {",
        "const f = ({ fetch }) => fetch(\"x\");",
        "  run({ setTimeout }: Deps): void {",
        "export default function App({ fetch }: Props) {",
    ],
)
def test_scanner_ignores_destructuring_and_parameters(line: str) -> None:
    assert stored_uncalled(line) == []


@pytest.mark.parametrize(
    "lines",
    [
        ["const css = `", "  clearTimer: clearTimeout,", "`;"],
        ["const {", "  fetch,", "  setTimeout,", "} = api;"],
        ["function run(", "  setTimeout,", ") {", "}"],
    ],
)
def test_scanner_ignores_multi_line_templates_patterns_and_parameters(lines: list[str]) -> None:
    assert stored_uncalled("\n".join(lines)) == []


def test_scanner_catches_shorthand_in_a_multi_line_object() -> None:
    text = "\n".join([
        "return {",
        "  scan: readEvidenceScan(),",
        "  setTimeout,",
        "  clearTimeout: clearTimeout,",
        "};",
    ])
    assert stored_uncalled(text) == [(3, "setTimeout,"), (4, "clearTimeout: clearTimeout,")]


def test_scanner_skips_block_comments_and_import_lists() -> None:
    text = "\n".join([
        "/**",
        " * setTimeout, clearTimeout,",
        " * clearTimer: clearTimeout,",
        " */",
        "import {",
        "  fetch,",
        "} from \"@tauri-apps/plugin-http\";",
        "export { fetch } from \"./http\";",
        "import.meta.hot?.accept(() => {",
        "const kept = { setTimeout };",
    ])
    assert stored_uncalled(text) == [(10, "const kept = { setTimeout };")]


def test_scanner_reads_comments_and_strings_left_to_right() -> None:
    text = "\n".join([
        "// written by launcher.sh (pane-sessions/*.txt)",
        "const kept = { setTimeout };",
        "const fence = /^```/u.test(line);",
        "const raf = window.requestAnimationFrame;",
        "const pattern = /^\\/\\//; const load = injected || fetch;",
        "const title = `${name}: ${\"x\"}`; // clearTimer: clearTimeout,",
    ])
    assert stored_uncalled(text) == [
        (2, "const kept = { setTimeout };"),
        (4, "const raf = window.requestAnimationFrame;"),
        (5, "const pattern = /^\\/\\//; const load = injected || fetch;"),
    ]


def test_scanner_follows_nested_templates_to_their_end() -> None:
    text = "\n".join([
        "const html = `",
        "  <ul>${items.map((item) => `<li>${item.name}</li>`).join(\"\")}</ul>",
        "  clearTimer: clearTimeout,",
        "`;",
        "const raf = window.requestAnimationFrame;",
    ])
    assert stored_uncalled(text) == [(5, "const raf = window.requestAnimationFrame;")]


@pytest.mark.parametrize(
    "line",
    [
        "const { clearTimeout } = window;",
        "const { fetch: load } = globalThis;",
        "({ setTimeout } = self);",
        "const { requestAnimationFrame = fallback } = window;",
        "const { fetch }: Pick<Window, \"fetch\"> = window;",
        "const { matchMedia } = window as Window;",
    ],
)
def test_scanner_catches_destructuring_straight_off_the_window(line: str) -> None:
    assert stored_uncalled(line) == [(1, line.strip())]


@pytest.mark.parametrize(
    "line",
    [
        "const { fetch } = window.api;",
        "const { fetch } = myWindow;",
        "const { fetch } = window || fallback;",
        # The window's `timer`, whatever it is, lands in a local that happens to be called clearTimeout.
        "const { timer: clearTimeout } = window;",
    ],
)
def test_scanner_ignores_destructuring_off_anything_but_the_window(line: str) -> None:
    assert stored_uncalled(line) == []


def test_scanner_catches_a_multi_line_pattern_off_the_window() -> None:
    text = "\n".join(["const {", "  setTimeout,", "  location,", "  clearTimeout: clear,", "} = window;"])
    assert stored_uncalled(text) == [(2, "setTimeout,"), (4, "clearTimeout: clear,")]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # Reported on the line that holds the function.
        ("const timer =\n  window.clearTimeout;", [(2, "window.clearTimeout;")]),
        ("const deps = {\n  clearTimer:\n    clearTimeout,\n};", [(3, "clearTimeout,")]),
        # No semicolon: the next statement starts on the next line.
        ("const clear = clearTimeout\nschedule(clear);", [(1, "const clear = clearTimeout")]),
    ],
)
def test_scanner_catches_a_value_across_a_line_break(text: str, expected: list[tuple[int, str]]) -> None:
    assert stored_uncalled(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "const send = window.fetch\n  .bind(globalThis);",
        "const request = fetch\n  (url);",
        "const ready = fetch\n  && enabled;",
    ],
)
def test_scanner_ignores_a_name_that_goes_on_to_the_next_line(text: str) -> None:
    assert stored_uncalled(text) == []


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("import {x} from \"m\"; const timer = clearTimeout;", [(1, "import {x} from \"m\"; const timer = clearTimeout;")]),
        ("import {\n  fetch,\n} from \"m\"; const timer = clearTimeout;", [(3, "} from \"m\"; const timer = clearTimeout;")]),
        ("import x from \"m\"\nconst timer = clearTimeout;", [(2, "const timer = clearTimeout;")]),
        ("import { fetch, setTimeout } from \"./timers\";", []),
        ("export { clearTimeout };", []),
    ],
)
def test_scanner_reads_the_code_after_an_import_statement(text: str, expected: list[tuple[int, str]]) -> None:
    assert stored_uncalled(text) == expected


def test_src_keeps_no_receiver_sensitive_function_uncalled() -> None:
    offenders = []
    for path in sorted([*SRC.rglob("*.ts"), *SRC.rglob("*.tsx")]):
        relative = path.relative_to(REPO_ROOT).as_posix()
        for number, code in stored_uncalled(path.read_text(encoding="utf-8")):
            offenders.append(f"{relative}:{number}: {code}")
    assert not offenders, (
        "window functions stored without a call throw \"Illegal invocation\" in WebView2"
        " once they are called as a method:\n  "
        + "\n  ".join(offenders)
        + f"\n{FIX_HINT}"
    )
