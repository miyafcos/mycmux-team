#!/usr/bin/env python3
"""oracmux — oracle-style consults on ChatGPT / Gemini / Grok web, tuned for mycmux.

    oracmux.py doctor  [--json] [--chrome] [--no-web] [--up] [--switch-to-chat]
    oracmux.py ask     --engine chatgpt|gemini|grok (-q TEXT | --question-file F) [--file P [P ...]]
                       [--mode M] [--via pane|oracle|cdp] [--tab T] [--close-tab] [--upload P [P ...]]
                       [--timeout-min N] [--dry-run] [--json]
    oracmux.py council (-q TEXT | --question-file F) [--engines a,b,c] [--file P [P ...]] [--via pane|cdp] [--no-html]
    oracmux.py push    --engine E (-q TEXT | --question-file F | --run-dir D) [--file P [P ...]] [--send]
    oracmux.py collect --engine E [--tab T | --url U | --latest] [--via pane|cdp] [--run-dir D]
    oracmux.py ledger  [--recent N] [--json]

Lanes: `pane` (default) runs inside mycmux: a background Web tab in the caller's
pane, `web.push` in, `web.read` out. `oracle` (chatgpt only) and `cdp` drive the
off-screen OracleChrome and stay as explicit fallbacks.
`--file` / `--upload` take one or more paths and may be repeated.

Exit codes: 0 ok / 1 error / 2 partial or timeout / 3 needs a human (login, captcha,
usage limit) / 4 UI not found / 5 guard blocked / 6 oracle busy / 7 precondition
(bad input, missing config, Chrome down, outside mycmux, usage error).
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from oracmux_lib import brief as brief_mod  # noqa: E402
from oracmux_lib import chrome  # noqa: E402
from oracmux_lib import engines as engines_mod  # noqa: E402
from oracmux_lib import guard as guard_mod  # noqa: E402
from oracmux_lib import ledger  # noqa: E402
from oracmux_lib import paths  # noqa: E402
from oracmux_lib import report  # noqa: E402
from oracmux_lib import run as run_mod  # noqa: E402

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_PARTIAL = 2
EXIT_NEEDS_HUMAN = 3
EXIT_UI = 4
EXIT_GUARD = 5
EXIT_BUSY = 6
EXIT_PRECONDITION = 7

STATUS_EXIT = {
    "ok": EXIT_OK,
    "partial": EXIT_PARTIAL,
    "timeout": EXIT_PARTIAL,
    "needs_human": EXIT_NEEDS_HUMAN,
    "failed": EXIT_UI,
    "busy": EXIT_BUSY,
    "precondition": EXIT_PRECONDITION,
    "guard_blocked": EXIT_GUARD,
}

COUNCIL_LABEL = "ChatGPT / Gemini / Grok"
COUNCIL_GRACE_SEC = 180.0


class Precondition(Exception):
    """Bad input, missing configuration, or an unsupported combination (exit 7)."""


def log(message: str) -> None:
    print(f"[oracmux {datetime.now():%H:%M:%S}] {message}", flush=True)


def emit_json(payload: dict[str, Any]) -> None:
    print("JSON " + json.dumps(payload, ensure_ascii=False, sort_keys=True), flush=True)


# ---------------------------------------------------------------- argparse helpers


def positive_float(value: str) -> float:
    try:
        number = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not a number: {value}") from exc
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError(f"must be a positive finite number: {value}")
    return number


def positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not an integer: {value}") from exc
    if number <= 0:
        raise argparse.ArgumentTypeError(f"must be a positive integer: {value}")
    return number


def non_negative_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"not an integer: {value}") from exc
    if number < 0:
        raise argparse.ArgumentTypeError(f"must be >= 0: {value}")
    return number


def read_text_arg(inline: str | None, file: str | None) -> str:
    if file:
        try:
            return brief_mod.read_text_strict(Path(file))
        except (OSError, ValueError) as exc:
            raise Precondition(str(exc)) from exc
    return inline or ""


def expand_files(patterns: list[str] | None) -> list[Path]:
    found: list[Path] = []
    for pattern in patterns or []:
        if any(char in pattern for char in "*?["):
            matches = sorted(Path(match) for match in glob.glob(pattern, recursive=True))
            if not matches:
                found.append(Path(pattern))  # reported as missing by the brief builder
            found.extend(matches)
        else:
            found.append(Path(pattern))
    unique: list[Path] = []
    seen: set[str] = set()
    for path in found:
        key = str(path.resolve()).lower() if path.exists() else str(path).lower()
        if key not in seen:
            seen.add(key)
            unique.append(path.resolve() if path.exists() else path)
    return unique


def add_question_arguments(parser: argparse.ArgumentParser, *, required: bool) -> None:
    group = parser.add_mutually_exclusive_group(required=required)
    group.add_argument("-q", "--question", help="問い (本文)")
    group.add_argument("--question-file", help="問いを書いた UTF-8 ファイル")
    parser.add_argument("--context", default="", help="経緯・文脈 (本文)")
    parser.add_argument("--context-file", help="経緯・文脈のファイル")
    parser.add_argument("--constraints", default="", help="制約 (本文)")
    parser.add_argument("--output-contract", default=brief_mod.DEFAULT_OUTPUT_CONTRACT, help="出力契約 (既定: 結論先行・根拠→結論・要確認明記・日本語)")
    parser.add_argument("--file", action="extend", nargs="+", default=[], help="添付するテキストファイル (複数可・glob 可・本文に展開)")
    parser.add_argument("--slug", help="run フォルダ名の slug (英数字とハイフンに正規化される)")
    parser.add_argument("--allow-markers", action="store_true", help="NDA マーカー検出を承知で送る (deny_roots・サイズ超過は上書き不可)")
    parser.add_argument("--max-inline-chars", type=positive_int, help="本文に展開する上限文字数 (既定: engines.json)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="oracmux", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="前提点検 (Chrome / ログイン / 枠 / mycmux Web ペイン)")
    doctor.add_argument("--json", action="store_true")
    doctor.add_argument("--no-web", action="store_true", help="サイトの実プローブを省く")
    doctor.add_argument("--up", action="store_true", help="OracleChrome が落ちていたら上げる")
    doctor.add_argument("--switch-to-chat", action="store_true", help="ChatGPT の Work 枠切れ復旧 (OracleChrome): Chat トグルを押す")
    doctor.add_argument("--chrome", action="store_true", help="OracleChrome 経路 (oracle/cdp) も点検する (既定はペインのみ)")

    ask = sub.add_parser("ask", help="1 エンジンに投げて回答を回収する")
    ask.add_argument("--engine", choices=engines_mod.ENGINE_IDS, required=True)
    add_question_arguments(ask, required=False)
    ask.add_argument("--mode", help="思考モード (engines.json の modes キー。既定: current)")
    ask.add_argument("--via", choices=("pane", "oracle", "cdp"), help="経路: pane = mycmux の Web ペイン裏タブ (既定・全エンジン) / oracle = steipete oracle CLI (chatgpt・OracleChrome) / cdp = 自前ドライバ (OracleChrome)")
    ask.add_argument("--tab", help="pane 経路: 既存の Web タブ (web-list の tabId) を使う (既定は裏タブを新規に開く)")
    ask.add_argument("--close-tab", action="store_true", help="pane 経路: 回収後にタブを閉じる (既定は残す)")
    ask.add_argument("--upload", action="extend", nargs="+", default=[], help="実アップロードする添付 (PDF 等・chatgpt + oracle 経路のみ)")
    ask.add_argument("--timeout-min", type=positive_float, help="全体タイムアウト (分)")
    ask.add_argument("--run-dir", help="既存 run フォルダを使う (council が使う。brief は再検査される)")
    ask.add_argument("--force", action="store_true", help="oracle セッション走行中でも実行する")
    ask.add_argument("--dry-run", action="store_true", help="brief と request.json を書いて止まる (送らない)")
    ask.add_argument("--json", action="store_true")

    council = sub.add_parser("council", help="同じ brief を 3 エンジンへ並列に投げ、判定用にまとめる")
    add_question_arguments(council, required=True)
    council.add_argument("--engines", default=",".join(engines_mod.ENGINE_IDS), help="カンマ区切り (既定: 3 つ全部)")
    for engine_id in engines_mod.ENGINE_IDS:
        council.add_argument(f"--mode-{engine_id}", help=f"{engine_id} の思考モード")
    council.add_argument("--timeout-min", type=positive_float, default=30.0)
    council.add_argument("--via", choices=("pane", "cdp"), default="pane", help="各レーンの経路 (既定: pane)")
    council.add_argument("--close-tabs", action="store_true", help="pane 経路: 回収後にタブを閉じる")
    council.add_argument("--no-html", action="store_true")
    council.add_argument("--force", action="store_true")
    council.add_argument("--dry-run", action="store_true")
    council.add_argument("--json", action="store_true")

    push = sub.add_parser("push", help="mycmux の Web ペインの composer に brief を載せる (送らない)")
    push.add_argument("--engine", choices=engines_mod.ENGINE_IDS, required=True)
    add_question_arguments(push, required=False)
    push.add_argument("--run-dir", help="既存 run の brief.md をそのまま載せる (再検査される)")
    push.add_argument("--send", action="store_true", help="載せた上で送信する (Pro のターンは取り消せない)")
    push.add_argument("--tab", help="web-list の tabId を指定する")
    push.add_argument("--dry-run", action="store_true")
    push.add_argument("--json", action="store_true")

    collect = sub.add_parser("collect", help="Web ペインで進めた会話を OracleChrome 経由で回収する")
    collect.add_argument("--engine", choices=engines_mod.ENGINE_IDS, required=True)
    target = collect.add_mutually_exclusive_group(required=False)
    target.add_argument("--url", help="会話 URL を裏タブで開いて回収 (pane) / OracleChrome で開いて回収 (cdp)")
    target.add_argument("--tab", help="pane 経路: 読む Web タブの tabId (web-list)")
    target.add_argument("--latest", action="store_true", help="cdp 経路: OracleChrome のサイドバー履歴の最新 (ピン留めは飛ばす)")
    collect.add_argument("--via", choices=("pane", "cdp"), help="経路 (既定: pane。--latest は cdp 固定)")
    collect.add_argument("--close-tab", action="store_true", help="pane 経路で --url から開いたタブを回収後に閉じる")
    collect.add_argument("--run-dir")
    collect.add_argument("--slug")
    collect.add_argument("--stable-sec", type=positive_float, default=20.0)
    collect.add_argument("--timeout-min", type=positive_float, default=15.0)
    collect.add_argument("--force", action="store_true", help="oracle セッション走行中でも実行する")
    collect.add_argument("--json", action="store_true")

    ledger_cmd = sub.add_parser("ledger", help="台帳を表示する")
    ledger_cmd.add_argument("--recent", type=non_negative_int, default=20)
    ledger_cmd.add_argument("--json", action="store_true")
    return parser


# ---------------------------------------------------------------- guard / brief helpers


def guard_paths(ns: argparse.Namespace, files: list[Path]) -> list[Path]:
    """Every path whose content ends up in front of the model is subject to
    deny_roots: attachments, the question/context files, and real uploads."""
    extra = [Path(value).resolve() for value in (getattr(ns, "question_file", None), getattr(ns, "context_file", None)) if value]
    extra.extend(expand_files(getattr(ns, "upload", None) or []))
    return list(files) + extra


def upload_texts(uploads: list[Path]) -> tuple[list[tuple[str, str]], list[str]]:
    """Content of text uploads for marker scanning; binaries are listed as unscanned
    (audit F-02: the guard says what it could not inspect)."""
    texts: list[tuple[str, str]] = []
    unscanned: list[str] = []
    for path in uploads:
        if not path.is_file():
            unscanned.append(f"{path}: missing")
            continue
        if brief_mod.language_for(path) is None:
            unscanned.append(f"{path}: binary, content not inspected by the guard")
            continue
        text, clean = brief_mod.decode_text(path.read_bytes())
        if not clean:
            unscanned.append(f"{path}: undecodable, content not inspected by the guard")
            continue
        texts.append((f"upload {path}", text))
    return texts, unscanned


def guard_check(
    text: str,
    files: list[Path],
    allow_markers: bool,
    extra_texts: list[tuple[str, str]] | None = None,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    cfg = guard_mod.load()
    hits = guard_mod.scan(text, files, cfg, extra_texts)
    blocking = guard_mod.blocking(hits, allow_markers)
    return [hit.as_dict() for hit in hits], [hit.as_dict() for hit in blocking]


def print_guard_block(blocking: list[dict[str, str]]) -> None:
    print("GUARD: blocked — the brief or its inputs carry confidentiality markers / deny roots / size limits:")
    for hit in blocking:
        print(f"  - [{hit['kind']}] {hit['where']}: {hit['detail']}")
    print("  marker hits can be overridden with --allow-markers after a human check; deny_roots and size cannot.")


def prepare_brief(ns: argparse.Namespace, engine_label: str, max_inline_chars: int) -> tuple[brief_mod.Brief, str, list[Path], str]:
    question = read_text_arg(ns.question, ns.question_file)
    if not question.strip():
        raise Precondition("question is empty: pass -q or --question-file")
    context = read_text_arg(ns.context, ns.context_file)
    files = expand_files(ns.file)
    slug = run_mod.slugify(ns.slug) if ns.slug else run_mod.slugify(question.strip().splitlines()[0][:40])
    try:
        built = brief_mod.build(
            question,
            engine_label=engine_label,
            slug=slug,
            context=context,
            constraints=ns.constraints,
            output_contract=ns.output_contract,
            files=files,
            max_inline_chars=ns.max_inline_chars or max_inline_chars,
        )
    except brief_mod.BriefTooLarge as exc:
        raise Precondition(str(exc)) from exc
    return built, slug, files, question


def write_request(run_dir: Path, payload: dict[str, Any]) -> None:
    run_mod.write_json(run_dir / "request.json", payload)


def reuse_brief(run_dir: Path, allow_markers: bool) -> tuple[str, list[dict[str, str]], list[dict[str, str]], dict[str, Any]]:
    """A reused brief is still a send: decode it strictly and rescan it together with
    the original input paths and uploads recorded in request.json (audit F-01 / F-05)."""
    brief_path = run_dir / "brief.md"
    if not brief_path.is_file():
        raise Precondition(f"run dir has no brief.md: {run_dir}")
    text = read_text_arg(None, str(brief_path))
    request = run_mod.read_json(run_dir / "request.json")
    recorded = [Path(item) for item in request.get("guard_paths", []) if isinstance(item, str)]
    uploads = [Path(item) for item in request.get("uploads", []) if isinstance(item, str)]
    extra, _unscanned = upload_texts(uploads)
    hits, blocking = guard_check(text, recorded + uploads, allow_markers, extra)
    return text, hits, blocking, request


def write_lane(eng_dir: Path, engine_id: str, meta: dict[str, Any], answer: str, citations: list[str], turns: list[dict[str, str]]) -> Path:
    archived = run_mod.archive_previous_outputs(eng_dir)  # audit F-36
    meta = dict(meta)
    meta["chars"] = len(answer)
    meta["collected_at"] = datetime.now().isoformat(timespec="seconds")
    if archived is not None:
        meta["previous_outputs"] = str(archived)
    run_mod.write_json(eng_dir / "meta.json", meta)
    target = eng_dir / ("answer.md" if meta.get("status") == "ok" else "partial.md")
    target.write_text(run_mod.answer_header(meta) + (answer or "") + "\n", encoding="utf-8")
    if citations:
        (eng_dir / "citations.txt").write_text("\n".join(citations) + "\n", encoding="utf-8")
    if turns:
        lines = [f"# transcript — {engine_id}", "", f"> {meta.get('turns_note', 'rendered turns')}", ""]
        for turn in turns:
            lines.append(f"## {turn.get('role', 'assistant')}")
            lines.append("")
            lines.append(str(turn.get("text", "")).rstrip())
            lines.append("")
        (eng_dir / "transcript.md").write_text("\n".join(lines), encoding="utf-8")
    return target


def summary_line(engine_id: str, meta: dict[str, Any], target: Path) -> None:
    print(
        f"{engine_id}: status={meta.get('status')} mode={meta.get('mode_requested')}->{meta.get('mode_actual')} "
        f"elapsed={meta.get('elapsed_sec', 0)}s chars={meta.get('chars', 0)} url={meta.get('conversation_url') or '-'}"
    )
    print(f"  {target}")
    if meta.get("error"):
        print(f"  error: {meta['error']}")
    if meta.get("tab_kept_open"):
        print(f"  tab kept open for the human: {meta.get('page_url', '')}")


def preflight_chrome(endpoint: str, force: bool) -> tuple[int, str]:
    try:
        state = chrome.ensure_up(endpoint)
    except RuntimeError as exc:
        return EXIT_PRECONDITION, str(exc)
    busy = chrome.busy_sessions()
    if busy and not force:
        ids = ", ".join(str(item["id"]) for item in busy)
        return EXIT_BUSY, f"oracle session running ({ids}); wait for it or pass --force"
    return EXIT_OK, state


def resolve_mode(site: dict[str, Any], requested: str | None) -> tuple[str, str]:
    mode = requested or str(site["default_mode"])
    if mode in site["modes"]:
        return mode, ""
    return str(site["default_mode"]), f"mode {requested} is not defined for {site['label']}; using {site['default_mode']}"


# ---------------------------------------------------------------- commands


def cmd_doctor(ns: argparse.Namespace) -> int:
    """Default = the pane lane: mycmux socket, open Web tabs per service and their
    signed-in / composer state. `--chrome` adds the OracleChrome lanes (oracle / cdp)."""
    data = engines_mod.load()
    endpoint = engines_mod.cdp_endpoint(data)
    result: dict[str, Any] = {"mycmux": {}, "engines": {}, "chrome": None, "chrome_engines": {}, "oracle_sessions": []}
    result["mycmux"]["inside"] = paths.in_mycmux()
    from oracmux_lib import pane, pane_driver

    try:
        tabs = pane.web_list()
        result["mycmux"]["web_tabs"] = tabs
        result["mycmux"]["socket"] = "ok"
        socket_ok = True
    except pane.PaneError as exc:
        result["mycmux"]["socket"] = f"unavailable: {str(exc)[:120]}"
        result["mycmux"]["web_tabs"] = []
        socket_ok = False
    if socket_ok:
        for engine_id in engines_mod.ENGINE_IDS:
            result["engines"][engine_id] = pane_driver.probe(engines_mod.engine(data, engine_id), log)
    else:
        for engine_id in engines_mod.ENGINE_IDS:
            result["engines"][engine_id] = {"ok": False, "status": "mycmux_down", "detail": "socket unavailable", "tabs": []}

    if ns.chrome or ns.switch_to_chat or ns.up:
        alive, detail = chrome.cdp_alive(endpoint)
        if not alive and ns.up:
            try:
                detail = chrome.ensure_up(endpoint)
                alive = True
            except RuntimeError as exc:
                detail = str(exc)
        result["chrome"] = {"endpoint": endpoint, "alive": alive, "detail": detail}
        result["oracle_sessions"] = chrome.running_oracle_sessions()
        if alive and ns.switch_to_chat:
            from oracmux_lib import cdp

            result["switch_to_chat"] = cdp.switch_chatgpt_to_chat(endpoint, log)
        if alive and not ns.no_web:
            from oracmux_lib import cdp

            for engine_id in engines_mod.ENGINE_IDS:
                result["chrome_engines"][engine_id] = cdp.probe(engines_mod.engine(data, engine_id), endpoint, log)

    print(f"mycmux: inside={result['mycmux']['inside']} socket={result['mycmux']['socket']} web_tabs={len(result['mycmux']['web_tabs'])}")
    for tab in result["mycmux"]["web_tabs"]:
        print(f"  tab {tab.get('tabId')} preset={tab.get('presetId')} title={tab.get('title')} background={tab.get('background')} active={tab.get('active')}")
    for engine_id, info in result["engines"].items():
        print(f"{engine_id} (pane): {info['status']} — {info['detail']}")
        for row in info.get("tabs", []):
            print(f"    tab {row.get('tabId')} signedOut={row.get('signedOut')} composer={row.get('composerPresent')} generating={row.get('generating')} turns={row.get('turns')} url={row.get('url')}")
    if result["chrome"] is not None:
        print(f"chrome: {endpoint} alive={result['chrome']['alive']} ({result['chrome']['detail']})")
        for session in result["oracle_sessions"]:
            print(f"oracle session: {session['id']} alive={session['alive']} zombie={session['zombie']} pid={session['controllerPid']}")
        if "switch_to_chat" in result:
            print(f"switch_to_chat: {result['switch_to_chat']}")
        for engine_id, info in result["chrome_engines"].items():
            print(f"{engine_id} (chrome): {info['status']} — {info['detail']} (mode label: {info.get('mode_label') or '-'})")
    if ns.json:
        emit_json(result)
    if not socket_ok:
        return EXIT_PRECONDITION
    statuses = {info["status"] for info in result["engines"].values()}
    if result["chrome"] is not None:
        statuses |= {info["status"] for info in result["chrome_engines"].values()}
        if not result["chrome"]["alive"]:
            return EXIT_PRECONDITION
    if statuses & {"not_logged_in", "captcha", "limit"}:
        return EXIT_NEEDS_HUMAN
    if statuses <= {"ok", "no_tab", "skipped"}:
        return EXIT_OK
    return EXIT_ERROR


def cmd_ask(ns: argparse.Namespace) -> int:
    data = engines_mod.load()
    site = engines_mod.engine(data, ns.engine)
    via = ns.via or "pane"
    if via == "oracle" and ns.engine != "chatgpt":
        raise Precondition("the oracle lane is ChatGPT only; gemini/grok use --via pane (default) or --via cdp")
    uploads = expand_files(ns.upload)
    if uploads and via != "oracle":
        raise Precondition("--upload is only delivered on the chatgpt + oracle lane; the pane/CDP lanes have no file upload (audit F-09)")
    if ns.tab and via != "pane":
        raise Precondition("--tab belongs to the pane lane")
    mode, mode_note = resolve_mode(site, ns.mode)
    if mode_note:
        log(mode_note)

    if ns.run_dir and not ns.question and not ns.question_file:
        run_dir = Path(ns.run_dir).resolve()
        text, hits, blocking, request = reuse_brief(run_dir, ns.allow_markers)
        brief_path = run_dir / "brief.md"
        slug = run_dir.name
        uploads = uploads or [Path(item) for item in request.get("uploads", []) if isinstance(item, str)]
        if uploads and via != "oracle":
            uploads = []
        if blocking:
            print_guard_block(blocking)
            ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "guard_blocked", "via": via, "mode": mode})
            return EXIT_GUARD
    else:
        built, slug, files, _question = prepare_brief(ns, str(site["label"]), int(site["max_inline_chars"]))
        text = built.text
        extra, unscanned = upload_texts(uploads)
        hits, blocking = guard_check(text, guard_paths(ns, files), ns.allow_markers, extra)
        run_dir = Path(ns.run_dir).resolve() if ns.run_dir else run_mod.new_run_dir(slug)
        run_dir.mkdir(parents=True, exist_ok=True)
        brief_path = run_dir / "brief.md"
        brief_path.write_text(text, encoding="utf-8", newline="\n")
        write_request(
            run_dir,
            {
                "command": "ask",
                "engine": ns.engine,
                "via": via,
                "mode": mode,
                "slug": slug,
                "files": [item.as_dict() for item in built.attachments],
                "guard_paths": [str(path) for path in guard_paths(ns, files)],
                "uploads": [str(path) for path in uploads],
                "uploads_unscanned": unscanned,
                "guard_hits": hits,
                "guard_blocking": blocking,
                "chars": built.total_chars,
                "created_at": datetime.now().isoformat(timespec="seconds"),
            },
        )
        for item in built.skipped:
            log(f"skipped {item.path}: {item.reason}")
        for note in unscanned:
            log(f"guard could not inspect: {note}")
        if blocking:
            print_guard_block(blocking)
            ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "guard_blocked", "via": via, "mode": mode})
            return EXIT_GUARD
    log(f"run {run_dir.name}: engine={ns.engine} via={via} mode={mode} brief={len(text)} chars")
    if ns.dry_run:
        ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "dry_run", "via": via, "mode": mode, "chars": len(text), "run_dir": str(run_dir)})
        print(f"dry-run: brief written, nothing sent\n  {brief_path}")
        if ns.json:
            emit_json({"run_dir": str(run_dir), "brief": str(brief_path), "chars": len(text), "guard_hits": hits, "dry_run": True})
        return EXIT_OK

    eng_dir = run_mod.engine_dir(run_dir, ns.engine)
    endpoint = engines_mod.cdp_endpoint(data)
    if via == "pane":
        state = "pane lane (mycmux Web pane, background tab)"
    else:
        code, state = preflight_chrome(endpoint, ns.force)
        if code != EXIT_OK:
            print(state)
            ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "busy" if code == EXIT_BUSY else "precondition", "via": via, "error": state})
            return code
    ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "started", "via": via, "mode": mode, "chars": len(text), "run_dir": str(run_dir)})
    log(f"lane: {state}")

    def progress(phase: str, fields: dict[str, Any]) -> None:
        run_mod.write_progress(eng_dir, phase, engine=ns.engine, **fields)

    meta: dict[str, Any] = {"engine": ns.engine, "via": via, "mode_requested": mode, "run_dir": str(run_dir)}
    answer = ""
    citations: list[str] = []
    turns: list[dict[str, str]] = []
    started = time.monotonic()
    if via == "pane":
        from oracmux_lib import pane_driver

        result = pane_driver.consult(
            site,
            brief_path,
            text,
            mode=mode,
            out_dir=eng_dir,
            log=log,
            progress=progress,
            timeouts={"overall_min": ns.timeout_min} if ns.timeout_min else None,
            tab_id=ns.tab,
            close_tab=ns.close_tab,
        )
        answer, citations, turns = result.answer, result.citations, result.turns
        meta.update(
            status=result.status,
            mode_actual=result.mode_actual,
            conversation_url=result.conversation_url,
            detection=result.detection,
            elapsed_sec=result.elapsed_sec,
            trace=result.trace,
            error=result.error,
            format=result.format,
            turns_note=result.turns_note,
            tab_kept_open=result.tab_kept_open,
            page_url=result.page_url,
            tab_id=result.tab_id,
        )
        if result.status == "needs_human":
            log("needs human: " + result.error + " (the pane tab is kept open; sign in there and re-run with --tab " + (result.tab_id or "<tabId>") + ")")
    elif via == "cdp":
        from oracmux_lib import cdp

        result = cdp.consult(
            site,
            endpoint,
            text,
            mode=mode,
            out_dir=eng_dir,
            log=log,
            progress=progress,
            timeouts={"overall_min": ns.timeout_min} if ns.timeout_min else None,
        )
        answer, citations, turns = result.answer, result.citations, result.turns
        meta.update(
            status=result.status,
            mode_actual=result.mode_actual,
            conversation_url=result.conversation_url,
            detection=result.detection,
            elapsed_sec=result.elapsed_sec,
            trace=result.trace,
            error=result.error,
            format=result.format,
            turns_note=result.turns_note,
            tab_kept_open=result.tab_kept_open,
            page_url=result.page_url,
        )
    else:
        from oracmux_lib import oracle_cli

        out_path = eng_dir / "answer.raw.md"
        session_slug = f"oracmux-{run_dir.name}"[:60]
        command = oracle_cli.build_command(brief_path, out_path, session_slug, uploads=uploads, research=(mode == "deep-research"))
        progress("oracle_running", {"session": session_slug})

        def oracle_progress(elapsed: float, size: int) -> None:
            progress("oracle_running", {"session": session_slug, "log_bytes": size})
            log(f"oracle running: {int(elapsed)}s, log {size} bytes")

        timeout_sec = (ns.timeout_min or float(site["timeouts"]["overall_min"])) * 60.0
        oracle_result = oracle_cli.run(command, timeout_sec, log, log_path=eng_dir / "oracle.log", progress=oracle_progress)
        answer = brief_mod.read_text(out_path) if out_path.is_file() else ""
        status = oracle_result.status
        if status == "ok" and not answer.strip():
            status = "failed"
        if status == "timeout" and answer.strip():
            status = "partial"
        conversation_url = oracle_result.conversation_url or oracle_cli.session_conversation_url(oracle_result.session_slug or session_slug)
        meta.update(
            status=status,
            mode_actual=("deep-research" if mode == "deep-research" else "current"),
            conversation_url=conversation_url,
            detection="oracle_cli",
            elapsed_sec=int(time.monotonic() - started),
            trace=[f"session={oracle_result.session_slug or session_slug}", f"evidence={oracle_result.evidence}", f"rc={oracle_result.returncode}"],
            error=oracle_result.error,
            oracle_session=oracle_result.session_slug or session_slug,
            format="oracle",
        )
        progress("done" if status == "ok" else "failed", {"session": session_slug, "status": status})
        if status == "needs_human":
            log("oracle reports a login / captcha / limit condition -> oracle-chrome show")
            chrome.show()
        if status in ("timeout", "partial"):
            log(f"oracle hung: reattach with `oracle session {oracle_result.session_slug or session_slug}` or run `oracmux.py collect --engine chatgpt --url <会話 URL>`")

    meta["chars"] = len(answer)
    target = write_lane(eng_dir, ns.engine, meta, answer, citations, turns)
    ledger.append(
        {
            "run_id": run_dir.name,
            "engine": ns.engine,
            "status": meta["status"],
            "mode_actual": meta.get("mode_actual", ""),
            "chars": len(answer),
            "url": meta.get("conversation_url", ""),
            "elapsed_sec": meta.get("elapsed_sec", 0),
            "error": meta.get("error", ""),
        }
    )
    summary_line(ns.engine, meta, target)
    if ns.json:
        emit_json({"run_dir": str(run_dir), "engine": ns.engine, **{k: v for k, v in meta.items() if k != "stdout_tail"}})
    return STATUS_EXIT.get(str(meta["status"]), EXIT_ERROR)


def lane_command(engine_id: str, run_dir: Path, mode: str, timeout_min: float, allow_markers: bool, via: str = "pane", close_tab: bool = False) -> list[str]:
    """One council lane = `ask --run-dir` in its own process (own tab, own poller)."""
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "ask",
        "--engine",
        engine_id,
        "--run-dir",
        str(run_dir),
        "--via",
        via,
        "--mode",
        mode,
        "--timeout-min",
        str(timeout_min),
        "--force",
        "--json",
    ]
    if allow_markers:
        command.append("--allow-markers")
    if close_tab and via == "pane":
        command.append("--close-tab")
    return command


def parse_engines(value: str) -> list[str]:
    selected = list(dict.fromkeys(item.strip() for item in value.split(",") if item.strip()))  # audit F-32
    unknown = [item for item in selected if item not in engines_mod.ENGINE_IDS]
    if unknown or not selected:
        raise Precondition(f"unknown engines: {unknown or 'none selected'}")
    return selected


def cmd_council(ns: argparse.Namespace) -> int:
    data = engines_mod.load()
    selected = parse_engines(ns.engines)
    max_inline = min(int(engines_mod.engine(data, item)["max_inline_chars"]) for item in selected)
    built, slug, files, question = prepare_brief(ns, COUNCIL_LABEL, max_inline)
    hits, blocking = guard_check(built.text, guard_paths(ns, files), ns.allow_markers)
    run_dir = run_mod.new_run_dir(run_mod.prefixed("council-", slug))
    brief_path = run_dir / "brief.md"
    brief_path.write_text(built.text, encoding="utf-8", newline="\n")
    modes = {item: resolve_mode(engines_mod.engine(data, item), getattr(ns, f"mode_{item}"))[0] for item in selected}
    write_request(
        run_dir,
        {
            "command": "council",
            "engines": selected,
            "modes": modes,
            "slug": slug,
            "question": question,
            "files": [item.as_dict() for item in built.attachments],
            "guard_paths": [str(path) for path in guard_paths(ns, files)],
            "uploads": [],
            "guard_hits": hits,
            "guard_blocking": blocking,
            "chars": built.total_chars,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        },
    )
    for item in built.skipped:
        log(f"skipped {item.path}: {item.reason}")
    if blocking:
        print_guard_block(blocking)
        for item in selected:
            ledger.append({"run_id": run_dir.name, "engine": item, "status": "guard_blocked", "council": True})
        return EXIT_GUARD
    log(f"council {run_dir.name}: engines={','.join(selected)} brief={built.total_chars} chars")
    if ns.dry_run:
        for item in selected:
            ledger.append({"run_id": run_dir.name, "engine": item, "status": "dry_run", "via": ns.via, "mode": modes[item], "chars": built.total_chars, "run_dir": str(run_dir), "council": True})
        print(f"dry-run: brief written, nothing sent\n  {brief_path}")
        if ns.json:
            emit_json({"run_dir": str(run_dir), "brief": str(brief_path), "engines": selected, "modes": modes, "dry_run": True})
        return EXIT_OK

    endpoint = engines_mod.cdp_endpoint(data)
    if ns.via == "pane":
        state = "pane lane (one background Web tab per engine in the caller's pane)"
    else:
        code, state = preflight_chrome(endpoint, ns.force)
        if code != EXIT_OK:
            print(state)
            for item in selected:
                ledger.append({"run_id": run_dir.name, "engine": item, "status": "busy" if code == EXIT_BUSY else "precondition", "council": True, "error": state})
            return code
    for item in selected:
        ledger.append({"run_id": run_dir.name, "engine": item, "status": "started", "via": ns.via, "mode": modes[item], "chars": built.total_chars, "run_dir": str(run_dir), "council": True})
    log(f"lane: {state}")

    processes: dict[str, subprocess.Popen[bytes]] = {}
    handles: list[Any] = []
    exit_codes: dict[str, int | None] = {}
    deadline = time.monotonic() + ns.timeout_min * 60.0 + COUNCIL_GRACE_SEC
    timed_out: list[str] = []
    try:
        for item in selected:
            eng_dir = run_mod.engine_dir(run_dir, item)
            command = lane_command(item, run_dir, modes[item], ns.timeout_min, ns.allow_markers, via=ns.via, close_tab=ns.close_tabs)
            handle = (eng_dir / "lane.log").open("ab")
            handles.append(handle)
            processes[item] = subprocess.Popen(command, stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=dict(os.environ, PYTHONIOENCODING="utf-8"))
            log(f"lane {item}: pid {processes[item].pid}")
            time.sleep(2.0)  # stagger tab creation in the shared Chrome
        last = 0.0
        while any(process.poll() is None for process in processes.values()):
            if time.monotonic() >= deadline:
                for item, process in processes.items():
                    if process.poll() is None:
                        timed_out.append(item)
                        process.kill()
                log("council deadline reached; killed lanes: " + ", ".join(timed_out))
                break
            if time.monotonic() - last >= 30:
                parts = []
                for item, process in processes.items():
                    progress = run_mod.read_progress(run_dir / item)
                    parts.append(f"{item}={progress.get('phase', 'starting')}({progress.get('chars', 0)}c)" if process.poll() is None else f"{item}=exit{process.returncode}")
                log(" ".join(parts))
                last = time.monotonic()
            time.sleep(5.0)
    finally:  # audit F-33: never leave children or log handles behind
        for item, process in processes.items():
            if process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass
            try:
                process.wait(timeout=30)
            except Exception:  # noqa: BLE001
                pass
            exit_codes[item] = process.returncode
        for handle in handles:
            try:
                handle.close()
            except OSError:
                pass

    lanes: list[dict[str, Any]] = []
    for item in selected:
        eng_dir = run_dir / item
        meta = run_mod.read_json(eng_dir / "meta.json")
        if item in timed_out:
            meta = {"status": "timeout", "error": "killed by the council deadline", "mode_requested": modes[item]}
        elif not meta:
            code_value = exit_codes.get(item)
            meta = {"status": "failed", "error": f"lane produced no meta.json (exit {code_value})", "mode_requested": modes[item]}
        answer_path = eng_dir / ("answer.md" if meta.get("status") == "ok" else "partial.md")
        answer = ""
        if answer_path.is_file():
            body = brief_mod.read_text(answer_path)
            answer = body.split("---", 2)[2].strip() if body.startswith("---") and body.count("---") >= 2 else body
        lanes.append(
            {
                "engine": item,
                "label": engines_mod.engine(data, item)["label"],
                "status": meta.get("status", "failed"),
                "mode_requested": meta.get("mode_requested", modes[item]),
                "mode_actual": meta.get("mode_actual", ""),
                "elapsed_sec": meta.get("elapsed_sec", 0),
                "chars": meta.get("chars", len(answer)),
                "conversation_url": meta.get("conversation_url", ""),
                "error": meta.get("error", ""),
                "exit_code": exit_codes.get(item),
                "answer": answer,
            }
        )
        ledger.append({"run_id": run_dir.name, "engine": item, "status": str(meta.get("status", "failed")), "council": True, "exit_code": exit_codes.get(item)})
    council_md = run_dir / "council.md"
    council_md.write_text(report.council_markdown(run_dir.name, question, lanes), encoding="utf-8")
    html_path: Path | None = None
    if not ns.no_html:
        try:
            html_path = report.render_html(council_md, f"oracmux council {run_dir.name}", "ChatGPT / Gemini / Grok 三者回答", "judge と合成は母艦が記入")
        except Exception as exc:  # noqa: BLE001
            log(f"html render failed: {exc}")
    ok_count = sum(1 for lane in lanes if lane["status"] == "ok")
    for lane in lanes:
        print(f"{lane['engine']}: {lane['status']} mode={lane['mode_requested']}->{lane['mode_actual']} {lane['elapsed_sec']}s {lane['chars']}c exit={lane['exit_code']} {lane['conversation_url'] or '-'}")
    print(f"council.md: {council_md}")
    if html_path:
        print(f"html: {html_path}")
    if ns.json:
        emit_json({"run_dir": str(run_dir), "council_md": str(council_md), "html": str(html_path) if html_path else "", "lanes": [{k: v for k, v in lane.items() if k != "answer"} for lane in lanes]})
    if ok_count == len(lanes):
        return EXIT_OK
    return EXIT_PARTIAL if ok_count else EXIT_ERROR


def cmd_push(ns: argparse.Namespace) -> int:
    if not paths.in_mycmux() and not ns.dry_run:
        raise Precondition("push needs a mycmux terminal (MYCMUX_TERM_PROGRAM=mycmux). Outside mycmux use `ask`.")
    data = engines_mod.load()
    site = engines_mod.engine(data, ns.engine)
    from oracmux_lib import pane

    if ns.run_dir and not ns.question and not ns.question_file:
        run_dir = Path(ns.run_dir).resolve()
        text, hits, blocking, _request = reuse_brief(run_dir, ns.allow_markers)
        if blocking:
            print_guard_block(blocking)
            ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "guard_blocked", "via": "pane"})
            return EXIT_GUARD
    else:
        if not ns.question and not ns.question_file:
            raise Precondition("push needs -q / --question-file or --run-dir")
        built, slug, files, _question = prepare_brief(ns, str(site["label"]), int(site["max_inline_chars"]))
        hits, blocking = guard_check(built.text, guard_paths(ns, files), ns.allow_markers)
        run_dir = run_mod.new_run_dir(run_mod.prefixed("push-", slug))
        (run_dir / "brief.md").write_text(built.text, encoding="utf-8", newline="\n")
        write_request(
            run_dir,
            {
                "command": "push",
                "engine": ns.engine,
                "send": ns.send,
                "files": [item.as_dict() for item in built.attachments],
                "guard_paths": [str(path) for path in guard_paths(ns, files)],
                "uploads": [],
                "guard_hits": hits,
                "guard_blocking": blocking,
                "chars": built.total_chars,
                "created_at": datetime.now().isoformat(timespec="seconds"),
            },
        )
        if blocking:
            print_guard_block(blocking)
            ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "guard_blocked", "via": "pane"})
            return EXIT_GUARD
        text = built.text
    # The bytes handed to mycmux are exactly the bytes measured here: UTF-8, no BOM,
    # LF line endings (audit F-58).
    push_path = run_dir / "brief.push.md"
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    push_path.write_bytes(normalized.encode("utf-8"))
    try:
        size = pane.check_text_size(normalized)
    except ValueError as exc:
        raise Precondition(str(exc)) from exc
    command = pane.build_push_command(str(site["pane_preset"]), push_path, send=ns.send, tab=ns.tab)
    if ns.dry_run:
        ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "dry_run", "via": "pane", "chars": len(normalized), "run_dir": str(run_dir)})
        print(f"dry-run: would push {size} bytes to preset {site['pane_preset']} (send={ns.send})\n  {push_path}")
        print("  " + subprocess.list2cmdline(command))
        if ns.json:
            emit_json({"run_dir": str(run_dir), "brief": str(push_path), "bytes": size, "send": ns.send, "preset": site["pane_preset"], "dry_run": True})
        return EXIT_OK
    try:
        result = pane.push(str(site["pane_preset"]), push_path, send=ns.send, tab=ns.tab)
    except RuntimeError as exc:
        print(f"push failed: {exc}")
        ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "push_failed", "via": "pane", "error": str(exc)[:200]})
        return EXIT_UI
    ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": "sent" if ns.send else "pushed", "via": "pane", "chars": len(normalized), "run_dir": str(run_dir)})
    print(f"pushed {size} bytes into the {site['label']} pane composer (send={ns.send})")
    print(f"  brief: {push_path}")
    print(f"  result: {json.dumps(result, ensure_ascii=False)}")
    print(f"  回収: python {Path(__file__).resolve()} collect --engine {ns.engine} --latest  (または --url <会話 URL>)")
    if ns.json:
        emit_json({"run_dir": str(run_dir), "engine": ns.engine, "bytes": size, "send": ns.send, "result": result})
    return EXIT_OK


def cmd_collect(ns: argparse.Namespace) -> int:
    data = engines_mod.load()
    site = engines_mod.engine(data, ns.engine)
    endpoint = engines_mod.cdp_endpoint(data)
    via = ns.via or ("cdp" if ns.latest else "pane")
    if via == "pane" and ns.latest:
        raise Precondition("--latest reads the OracleChrome sidebar (cdp lane); on the pane lane use --tab, --url, or nothing (= the latest open pane of that service)")
    if via == "cdp" and ns.tab:
        raise Precondition("--tab belongs to the pane lane")
    run_dir = Path(ns.run_dir).resolve() if ns.run_dir else run_mod.new_run_dir(ns.slug or f"collect-{ns.engine}")
    run_dir.mkdir(parents=True, exist_ok=True)
    eng_dir = run_mod.engine_dir(run_dir, ns.engine)
    if via == "pane":
        from oracmux_lib import pane_driver

        log("lane: pane (mycmux Web pane)")
        result = pane_driver.collect(site, tab_id=ns.tab, url=ns.url, log=log, stable_sec=ns.stable_sec, overall_sec=ns.timeout_min * 60.0, close_tab=ns.close_tab)
    else:
        code, state = preflight_chrome(endpoint, ns.force)  # audit F-29
        if code != EXIT_OK:
            print(state)
            return code
        log(f"chrome: {state}")
        from oracmux_lib import cdp

        result = cdp.collect(site, endpoint, url=ns.url, out_dir=eng_dir, log=log, stable_sec=ns.stable_sec, overall_sec=ns.timeout_min * 60.0)
    meta: dict[str, Any] = {
        "engine": ns.engine,
        "via": "collect-" + via,
        "status": result.status,
        "mode_requested": "collect",
        "mode_actual": result.mode_actual,
        "conversation_url": result.conversation_url,
        "detection": result.detection,
        "elapsed_sec": result.elapsed_sec,
        "trace": result.trace,
        "error": result.error,
        "run_dir": str(run_dir),
        "format": result.format,
        "turns_note": result.turns_note,
        "tab_kept_open": result.tab_kept_open,
        "page_url": result.page_url,
        "tab_id": result.tab_id,
        "chars": len(result.answer),
    }
    target = write_lane(eng_dir, ns.engine, meta, result.answer, result.citations, result.turns)
    ledger.append({"run_id": run_dir.name, "engine": ns.engine, "status": result.status, "via": "collect-" + via, "chars": len(result.answer), "url": result.conversation_url, "error": result.error})
    summary_line(ns.engine, meta, target)
    if result.turns:
        print(f"  transcript: {eng_dir / 'transcript.md'} ({len(result.turns)} turns; {result.turns_note})")
    if ns.json:
        emit_json({"run_dir": str(run_dir), **{k: v for k, v in meta.items()}})
    return STATUS_EXIT.get(result.status, EXIT_ERROR)


def cmd_ledger(ns: argparse.Namespace) -> int:
    rows = ledger.recent(ns.recent)
    if ns.json:
        print(json.dumps(rows, ensure_ascii=True, indent=1))
        return EXIT_OK
    if not rows:
        print(f"ledger is empty: {paths.ledger_path()}")
        return EXIT_OK
    print(f"ledger: {paths.ledger_path()}")
    for row in rows:
        print(
            f"{row.get('last_ts', row.get('ts', ''))}  {row.get('run_id', '')}  {row.get('engine', '')}  {row.get('status', '')}  "
            f"via={row.get('via', '')} mode={row.get('mode_actual') or row.get('mode', '')} chars={row.get('chars', '')} {row.get('url', '')}"
        )
    return EXIT_OK


HANDLERS = {
    "doctor": cmd_doctor,
    "ask": cmd_ask,
    "council": cmd_council,
    "push": cmd_push,
    "collect": cmd_collect,
    "ledger": cmd_ledger,
}


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
    parser = build_parser()
    try:
        ns = parser.parse_args(argv)
    except SystemExit as exc:  # argparse usage error / --help
        code = exc.code if isinstance(exc.code, int) else EXIT_PRECONDITION
        return EXIT_OK if code == 0 else EXIT_PRECONDITION
    try:
        return HANDLERS[ns.command](ns)
    except Precondition as exc:
        print(str(exc))
        return EXIT_PRECONDITION
    except (engines_mod.EngineContractError, guard_mod.GuardConfigError) as exc:
        print(f"configuration error: {exc}")
        return EXIT_PRECONDITION
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"input/config error: {type(exc).__name__}: {exc}")
        return EXIT_PRECONDITION
    except subprocess.SubprocessError as exc:
        print(f"helper process failed: {exc}")
        return EXIT_UI
    except KeyboardInterrupt:
        print("interrupted")
        return 130
    except RuntimeError as exc:
        print(f"error: {exc}")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
