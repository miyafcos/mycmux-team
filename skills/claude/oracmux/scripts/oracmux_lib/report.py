"""Council compilation and HTML rendering (quick_html.py)."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import paths

STATUS_CHIP = {
    "ok": '<span class="chip ok">回収済</span>',
    "partial": '<span class="chip warn">途中まで</span>',
    "needs_human": '<span class="chip warn">要人手</span>',
    "failed": '<span class="chip ng">失敗</span>',
    "timeout": '<span class="chip ng">時間切れ</span>',
    "precondition": '<span class="chip ng">前提不足</span>',
    "busy": '<span class="chip warn">oracle 走行中</span>',
}

JUDGE_TEMPLATE = """## judge (母艦が記入)

- **合意点**:
- **矛盾点** (どちらが妥当か・根拠):
- **カバー範囲の差** (ある枠だけが触れた論点):
- **固有の洞察**:
- **盲点** (全枠が見落とした可能性):

## 合成回答 (母艦が記入)

- 結論:
- 根拠:
- confidence (高/中/低) と、低いときに人が確認すべき点:
"""

FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")


def council_markdown(run_id: str, question: str, lanes: list[dict[str, Any]]) -> str:
    lines = [f"# oracmux council — {run_id}", ""]
    lines.append("同じ引き継ぎ書を ChatGPT / Gemini / Grok の Web に投げ、回収した回答を並べたもの。judge と合成は母艦が書く。")
    lines.append("回答は画面の表示テキスト (innerText) で、Markdown の記法は復元していない。")
    lines.append("")
    lines.append("## 問い")
    lines.append("")
    lines.append(question.strip())
    lines.append("")
    lines.append("## 回収状況")
    lines.append("")
    lines.append("| エンジン | 状態 | モード (要求→実際) | 所要 | 文字数 | 会話 URL |")
    lines.append("|---|---|---|---|---|---|")
    for lane in lanes:
        status = str(lane.get("status", "failed"))
        chip = STATUS_CHIP.get(status, STATUS_CHIP["failed"])
        mode = f"{lane.get('mode_requested', '')}→{lane.get('mode_actual', '')}"
        url = str(lane.get("conversation_url") or "")
        lines.append(
            f"| {lane.get('label', lane.get('engine'))} | {chip} | {mode} | {lane.get('elapsed_sec', 0)}s | {lane.get('chars', 0)} | {url} |"
        )
    lines.append("")
    for lane in lanes:
        lines.append(f"## {lane.get('label', lane.get('engine'))} の回答")
        lines.append("")
        answer = str(lane.get("answer") or "").strip()
        if not answer:
            lines.append(f"(回収なし: {lane.get('error', '')})")
        else:
            lines.append(demote_headings(answer))
        lines.append("")
    lines.append(JUDGE_TEMPLATE)
    return "\n".join(lines).rstrip() + "\n"


def demote_headings(markdown: str) -> str:
    """Answers carry their own headings; keep them below the lane heading (h2).
    Lines inside fenced code blocks are left alone (audit F-45)."""
    out: list[str] = []
    fence: str | None = None
    for line in markdown.splitlines():
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            if fence is None:
                fence = marker[0] * 3
            elif line.strip().startswith(fence):
                fence = None
            out.append(line)
            continue
        if fence is None:
            out.append(re.sub(r"^(#{1,6})\s", lambda m: "#" * min(6, len(m.group(1)) + 2) + " ", line))
        else:
            out.append(line)
    return "\n".join(out)


def render_html(md_path: Path, title: str, subject: str, note: str = "", out: Path | None = None) -> Path:
    command = [sys.executable, str(paths.quick_html()), "--title", title, "--md", str(md_path), "--subject", subject]
    if note:
        command.extend(["--note", note])
    if out:
        command.extend(["--out", str(out)])
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout).strip()[-600:])
    for line in reversed((completed.stdout or "").splitlines()):
        candidate = line.strip()
        if candidate.lower().endswith(".html") and Path(candidate).is_file():
            return Path(candidate)
    if out and out.is_file():
        return out
    raise RuntimeError("quick_html.py did not report an output path: " + (completed.stdout or "")[-300:])
