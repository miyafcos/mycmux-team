"""NDA / confidentiality guard.

Rule (CLAUDE.md, delegation.md): NDA material and anything not cleared for
outside disclosure never goes to a web service — ChatGPT, Gemini and Grok
are all external services.

The guard is deterministic on purpose. It cannot know what is secret; it can
only catch the markers people actually put on such material and the folders
the operator declared off-limits (guard.json `deny_roots`). Hits block the
send unless the caller overrides marker hits explicitly. Deny-root and size
hits are never overridable from the CLI.

Hardened after the 2026-09-07 audit: NFKC + zero-width stripping (full-width
and invisible-character tricks), whitespace-tolerant marker patterns with
word boundaries ("DO  NOT DISTRIBUTE", "N D A", "社 外 秘"), fail-closed on a
missing configuration file, strict configuration validation, and content
scanning of every text input the caller hands over (uploads included).
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from . import paths

DEFAULT_GUARD: dict[str, object] = {
    "markers_ja": ["社外秘", "部外秘", "取扱注意", "機密", "極秘", "関係者外秘"],
    "markers_ascii": ["NDA", "CONFIDENTIAL", "DO NOT DISTRIBUTE", "INTERNAL ONLY"],
    "deny_roots": [],
    "max_total_chars": 200000,
}

KIND_MARKER = "marker"
KIND_DENY_ROOT = "deny_root"
KIND_SIZE = "size"

MAX_HITS_PER_MARKER = 3

# Characters that hide a marker from a naive substring search without changing
# what a reader sees: zero-width space/joiners, word joiner, BOM, soft hyphen.
ZERO_WIDTH = "".join(chr(code) for code in (0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF, 0x00AD))
_ZERO_WIDTH_TABLE = {ord(char): None for char in ZERO_WIDTH}


def normalize_text(text: str) -> str:
    """NFKC (full-width ASCII -> ASCII, compatibility forms) minus zero-width chars.
    Newlines survive, so line numbers computed on the result still match."""
    return unicodedata.normalize("NFKC", text).translate(_ZERO_WIDTH_TABLE)


@dataclass
class Hit:
    kind: str
    where: str
    detail: str

    def as_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "where": self.where, "detail": self.detail}


class GuardConfigError(ValueError):
    pass


def _validate(merged: dict[str, object], source: str) -> None:
    for key in ("markers_ja", "markers_ascii", "deny_roots"):
        value = merged.get(key)
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise GuardConfigError(f"{source}: {key} must be a list of strings")
        if any(not item.strip() for item in value):
            raise GuardConfigError(f"{source}: {key} contains an empty entry")
    limit = merged.get("max_total_chars")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        raise GuardConfigError(f"{source}: max_total_chars must be a positive integer")


def load(path: Path | None = None) -> dict[str, object]:
    """Fail closed: a missing or malformed guard file stops the send (a typo in
    ORACMUX_GUARD must not silently drop deny_roots)."""
    target = path or paths.guard_json()
    if not target.is_file():
        raise GuardConfigError(f"guard configuration not found: {target}")
    try:
        data = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardConfigError(f"guard configuration unreadable: {target}: {exc}") from exc
    if not isinstance(data, dict):
        raise GuardConfigError(f"{target}: root must be an object")
    merged = dict(DEFAULT_GUARD)
    merged.update({key: value for key, value in data.items() if not key.startswith("_")})
    _validate(merged, str(target))
    return merged


def normalize_path(value: str | Path) -> str:
    text = str(Path(value).expanduser().resolve())
    return text.replace("/", "\\").rstrip("\\").lower()


def _line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def marker_pattern(marker: str) -> re.Pattern[str]:
    """Whitespace-tolerant, boundary-preserving pattern for one marker.

    Any run of whitespace may appear between the marker's characters (so
    "N D A", "DO  NOT DISTRIBUTE" and "社 外 秘" all match), but the match
    must not be glued to surrounding letters/digits ("standard" never hits NDA).
    """
    chars = [re.escape(char) for char in normalize_text(marker) if not char.isspace()]
    body = r"\s*".join(chars)
    return re.compile(r"(?<![A-Za-z0-9])" + body + r"(?![A-Za-z0-9])", re.IGNORECASE)


def scan_text(text: str, cfg: dict[str, object], where: str) -> list[Hit]:
    normalized = normalize_text(text)
    hits: list[Hit] = []
    for marker in list(cfg["markers_ja"]) + list(cfg["markers_ascii"]):  # type: ignore[arg-type]
        pattern = marker_pattern(marker)
        for count, match in enumerate(pattern.finditer(normalized)):
            if count >= MAX_HITS_PER_MARKER:
                break
            hits.append(Hit(KIND_MARKER, where, f"{marker} @ line {_line_of(normalized, match.start())}"))
    return hits


def scan_paths(files: list[Path] | tuple[Path, ...], cfg: dict[str, object]) -> list[Hit]:
    roots = [normalize_path(root) for root in cfg["deny_roots"]]  # type: ignore[union-attr]
    hits: list[Hit] = []
    for raw in files:
        candidate = normalize_path(raw)
        for root in roots:
            if candidate == root or candidate.startswith(root + "\\"):
                hits.append(Hit(KIND_DENY_ROOT, str(raw), f"under deny root {root}"))
    return hits


def scan(
    brief_text: str,
    files: list[Path] | tuple[Path, ...],
    cfg: dict[str, object],
    extra_texts: list[tuple[str, str]] | None = None,
) -> list[Hit]:
    """brief_text is scanned for markers and size; `files` for deny roots;
    `extra_texts` (e.g. the content of uploads) for markers under their own label."""
    hits = scan_paths(files, cfg)
    hits.extend(scan_text(brief_text, cfg, "brief"))
    for where, text in extra_texts or []:
        hits.extend(scan_text(text, cfg, where))
    limit = int(cfg["max_total_chars"])  # type: ignore[arg-type]
    if len(brief_text) > limit:
        hits.append(Hit(KIND_SIZE, "brief", f"{len(brief_text)} chars > max_total_chars {limit}"))
    return hits


def blocking(hits: list[Hit], allow_markers: bool) -> list[Hit]:
    """Return the hits that still block after the caller's override."""
    return [hit for hit in hits if not (allow_markers and hit.kind == KIND_MARKER)]
