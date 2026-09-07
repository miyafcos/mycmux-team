"""Build the handoff brief: the one text that is pasted into a web composer.

Design (from docs/plans/2026-08-27-web-pane-chatgpt-requirements.md, decision 6):
an agent writes a short brief (論点・経緯・問い・制約・添付一覧) and inlines the
real files it needs. Raw transcripts are never sent.

Rules baked in here:
- The stance line (読者／語り手／相手／その先) is the first line — 成果物ドクトリン.
- JSON is minified to one line: ProseMirror chokes on thousands of paragraph
  nodes, not on bytes (2026-09-02 measurement: 2,770 lines hung, 1 line posted).
- Every file is accounted for: inlined, or skipped with a reason. Nothing is
  silently dropped, nothing is silently truncated (audit F-06: the limit is
  enforced on the final text; a question that alone exceeds it is an error).
- Fences grow when the content itself contains backticks.
- Bytes that are neither UTF-8 nor cp932 are never pasted with U+FFFD.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_OUTPUT_CONTRACT = (
    "結論を先に書く。根拠→結論の順で書き、根拠のない断定はしない。"
    "不確かな点は【要確認】と明記する。日本語で答える。"
)
DEFAULT_STANCE = "読者＝{engine}／語り手＝弊社の作業エージェント／相手＝{engine}／その先＝宮崎さん (裁定者)"

TEXT_EXTENSIONS: dict[str, str] = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".py": "python",
    ".ts": "ts",
    ".tsx": "tsx",
    ".js": "js",
    ".mjs": "js",
    ".json": "json",
    ".jsonl": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".rs": "rust",
    ".html": "html",
    ".css": "css",
    ".csv": "csv",
    ".tsv": "tsv",
    ".ps1": "powershell",
    ".sh": "bash",
    ".ini": "ini",
    ".cfg": "ini",
    ".xml": "xml",
    ".svg": "xml",
    ".sql": "sql",
    ".rb": "ruby",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".tex": "latex",
}

SKIP_MISSING = "missing"
SKIP_TOO_LARGE = "too_large"
SKIP_BINARY = "binary"
SKIP_OVER_INLINE_LIMIT = "over_inline_limit"
SKIP_EMPTY = "empty"
SKIP_UNDECODABLE = "undecodable"


class BriefTooLarge(ValueError):
    pass


@dataclass
class Attachment:
    path: Path
    size: int
    chars: int
    lang: str
    kind: str  # "inline" | "skipped"
    reason: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "path": str(self.path),
            "size": self.size,
            "chars": self.chars,
            "lang": self.lang,
            "kind": self.kind,
            "reason": self.reason,
        }


@dataclass
class Brief:
    text: str
    attachments: list[Attachment] = field(default_factory=list)

    @property
    def total_chars(self) -> int:
        return len(self.text)

    @property
    def inlined(self) -> list[Attachment]:
        return [item for item in self.attachments if item.kind == "inline"]

    @property
    def skipped(self) -> list[Attachment]:
        return [item for item in self.attachments if item.kind == "skipped"]


def decode_text(raw: bytes) -> tuple[str, bool]:
    """UTF-8 (BOM tolerant) first, then cp932; (text, clean). A file that is
    neither comes back with U+FFFD replacements and clean=False, and the caller
    decides — a brief must never carry silently mangled bytes."""
    for encoding in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(encoding), True
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), False


def read_text(path: Path) -> str:
    return decode_text(path.read_bytes())[0]


def read_text_strict(path: Path) -> str:
    text, clean = decode_text(path.read_bytes())
    if not clean:
        raise ValueError(f"{path} is neither UTF-8 nor cp932; re-save it as UTF-8")
    return text


def minify_json(text: str) -> str:
    try:
        return json.dumps(json.loads(text), ensure_ascii=False, separators=(",", ":"))
    except (json.JSONDecodeError, TypeError, ValueError):
        return text


def fence_for(content: str) -> str:
    longest = 0
    run = 0
    for char in content:
        if char == "`":
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    return "`" * max(3, longest + 1)


def language_for(path: Path) -> str | None:
    return TEXT_EXTENSIONS.get(path.suffix.lower())


def _section(title: str, body: str) -> str:
    body = body.strip()
    return f"## {title}\n\n{body}\n\n" if body else ""


def _listing(attachments: list[Attachment]) -> str:
    if not attachments:
        return ""
    lines = "\n".join(
        f"- {item.path} — {'添付 (本文に展開)' if item.kind == 'inline' else '未添付: ' + item.reason}"
        for item in attachments
    )
    return _section("添付一覧", lines)


def _assemble(head: str, attachments: list[Attachment], blocks: dict[int, str]) -> str:
    text = head + _listing(attachments)
    inline_blocks = [blocks[index] for index, item in enumerate(attachments) if item.kind == "inline"]
    if inline_blocks:
        text += "## 添付ファイル本文\n\n" + "".join(inline_blocks)
    return text.rstrip() + "\n"


def build(
    question: str,
    *,
    engine_label: str,
    slug: str = "consult",
    context: str = "",
    constraints: str = "",
    output_contract: str = DEFAULT_OUTPUT_CONTRACT,
    files: tuple[Path, ...] | list[Path] = (),
    max_inline_chars: int = 60000,
    max_file_bytes: int = 1_000_000,
    stance: str | None = None,
) -> Brief:
    if not question or not question.strip():
        raise ValueError("question must not be empty")
    if max_inline_chars <= 0:
        raise ValueError("max_inline_chars must be positive")
    stance_line = (stance or DEFAULT_STANCE).format(engine=engine_label)
    head = f"# oracmux brief — {slug}\n\n{stance_line}\n\n"
    head += _section("論点 (問い)", question)
    head += _section("経緯・文脈", context)
    head += _section("制約", constraints)
    head += _section("出力契約", output_contract)
    if len(head) > max_inline_chars:
        raise BriefTooLarge(
            f"question/context/constraints alone are {len(head)} chars, over the {max_inline_chars}-char limit; shorten them or raise --max-inline-chars"
        )

    attachments: list[Attachment] = []
    blocks: dict[int, str] = {}
    # Greedy in the caller's order: a file is inlined only if it fits the space
    # left after the head and the listing line it will add; the final loop below
    # is the safety net for the headings the listing itself adds.
    budget = max_inline_chars - len(head) - len("## 添付一覧") - len("## 添付ファイル本文") - 8
    for raw in files:
        path = Path(raw)
        index = len(attachments)
        listing_cost = len(str(path)) + 24
        if not path.is_file():
            attachments.append(Attachment(path, 0, 0, "", "skipped", SKIP_MISSING))
            budget -= listing_cost
            continue
        size = path.stat().st_size
        lang = language_for(path)
        if lang is None:
            attachments.append(Attachment(path, size, 0, "", "skipped", SKIP_BINARY))
            continue
        if size > max_file_bytes:
            attachments.append(Attachment(path, size, 0, lang, "skipped", SKIP_TOO_LARGE))
            continue
        content, clean = decode_text(path.read_bytes())
        if not clean:
            attachments.append(Attachment(path, size, 0, lang, "skipped", SKIP_UNDECODABLE))
            continue
        if lang == "json":
            content = minify_json(content)
        content = content.strip("\n")
        if not content.strip():
            attachments.append(Attachment(path, size, 0, lang, "skipped", SKIP_EMPTY))
            continue
        fence = fence_for(content)
        block = f"### FILE: {path} ({size} bytes)\n\n{fence}{lang}\n{content}\n{fence}\n\n"
        if len(block) + listing_cost > budget:
            attachments.append(Attachment(path, size, len(content), lang, "skipped", SKIP_OVER_INLINE_LIMIT))
            budget -= listing_cost
            continue
        budget -= len(block) + listing_cost
        blocks[index] = block
        attachments.append(Attachment(path, size, len(content), lang, "inline"))

    # Enforce the limit on the final text (headings and the listing included):
    # drop inlined files from the end until it fits, and say so in the listing.
    text = _assemble(head, attachments, blocks)
    while len(text) > max_inline_chars:
        inline_indexes = [index for index, item in enumerate(attachments) if item.kind == "inline"]
        if not inline_indexes:
            raise BriefTooLarge(f"brief is {len(text)} chars even without attachments, over the {max_inline_chars}-char limit")
        last = inline_indexes[-1]
        item = attachments[last]
        attachments[last] = Attachment(item.path, item.size, item.chars, item.lang, "skipped", SKIP_OVER_INLINE_LIMIT)
        blocks.pop(last, None)
        text = _assemble(head, attachments, blocks)
    return Brief(text=text, attachments=attachments)
