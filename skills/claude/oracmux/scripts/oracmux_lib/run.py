"""Run directory layout, slugs and progress files.

    ~/.mycmux/handoff/oracmux/<YYMMDD-HHMM>-<slug>/
        brief.md          the text that was (or will be) sent
        request.json      arguments, attachments, guard result, guard paths
        <engine>/
            progress.json phase / elapsed / chars — polled by the mothership
            answer.md     final answer with a header block
            meta.json     status, mode, conversation URL, timings, trace
            citations.txt one URL per line
            transcript.md rendered turns (what the page currently shows)
            partial.md    whatever was captured when a lane failed
            fail.png      screenshot on failure (best effort)
            _prev/<ts>/   outputs of an earlier attempt in the same lane dir
        council.md        (council) all lanes compiled for the judge
        judge.md          (council) written by the mothership
"""

from __future__ import annotations

import json
import re
import shutil
import unicodedata
from datetime import datetime
from pathlib import Path

from . import paths

SLUG_MAX = 32
LANE_OUTPUTS = ("answer.md", "partial.md", "citations.txt", "transcript.md", "fail.png", "answer.raw.md", "lane.log")


def slugify(text: str, fallback: str = "consult") -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    ascii_text = re.sub(r"[^A-Za-z0-9]+", "-", ascii_text).strip("-").lower()
    ascii_text = re.sub(r"-{2,}", "-", ascii_text)
    if not ascii_text:
        return fallback
    return ascii_text[:SLUG_MAX].rstrip("-") or fallback


def prefixed(prefix: str, slug: str) -> str:
    """`council-` + a slug that already starts with `council-` stays single."""
    return slug if slug.startswith(prefix) else prefix + slug


def new_run_dir(slug: str, now: datetime | None = None, root: Path | None = None) -> Path:
    """Create a fresh run folder; concurrent callers in the same minute get -2, -3, ...
    (mkdir with exist_ok=False is the atomic check)."""
    base = (root or paths.home()).resolve()
    slug = slugify(slug, fallback="consult")
    stamp = (now or datetime.now()).strftime("%y%m%d-%H%M")
    base.mkdir(parents=True, exist_ok=True)
    counter = 1
    while True:
        name = f"{stamp}-{slug}" if counter == 1 else f"{stamp}-{slug}-{counter}"
        candidate = base / name
        try:
            candidate.mkdir(parents=False, exist_ok=False)
            return candidate
        except FileExistsError:
            counter += 1
            if counter > 999:
                raise


def engine_dir(run_dir: Path, engine_id: str) -> Path:
    target = run_dir / engine_id
    target.mkdir(parents=True, exist_ok=True)
    return target


def archive_previous_outputs(engine_dir_path: Path) -> Path | None:
    """Move an earlier attempt's outputs into _prev/<ts>/ so a re-run never mixes
    old answer.md with a new partial.md (audit F-36). Returns the archive dir."""
    present = [engine_dir_path / name for name in LANE_OUTPUTS if (engine_dir_path / name).exists()]
    if not present:
        return None
    archive = engine_dir_path / "_prev" / datetime.now().strftime("%Y%m%d-%H%M%S")
    archive.mkdir(parents=True, exist_ok=True)
    for path in present:
        shutil.move(str(path), str(archive / path.name))
    return archive


def write_json(path: Path, data: dict[str, object]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")


def read_json(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def write_progress(engine_dir_path: Path, phase: str, **fields: object) -> None:
    data: dict[str, object] = {"phase": phase, "updated_at": datetime.now().isoformat(timespec="seconds")}
    data.update(fields)
    write_json(engine_dir_path / "progress.json", data)


def read_progress(engine_dir_path: Path) -> dict[str, object]:
    return read_json(engine_dir_path / "progress.json")


def answer_header(meta: dict[str, object]) -> str:
    lines = ["---"]
    for key in ("engine", "status", "mode_requested", "mode_actual", "conversation_url", "elapsed_sec", "detection", "chars", "collected_at"):
        if key in meta:
            lines.append(f"{key}: {meta[key]}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"
