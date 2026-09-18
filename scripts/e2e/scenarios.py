"""End-to-end scenarios for a test build (see mycmux_e2e.py).

Usage (on the machine running the test build):
    python3 scenarios.py --bundle <path/to/mycmux.app> [--profile e2e] [names...]

Each scenario starts from an empty profile, prints one JSON line per step and
ends with a verdict line: {"event": "verdict", "scenario": ..., "checks": {...}}.
Exit status is non-zero when any check failed.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mycmux_e2e import App, E2eError, log  # noqa: E402

DETACHED_LABEL = "mycmux-w1"
CLOSE_BUTTON_TITLES = ("閉じる", "終了", "OK")


QUARANTINE = Path.home() / "Developer/macq-e2e/_old"


def fresh_start(app: App) -> None:
    """Start the test profile from nothing.

    The previous run's directories are moved aside, never deleted: removing
    files needs the operator's say-so, and a moved folder can still be looked
    at when a run needs explaining.
    """
    stop(app)
    data_dir = (
        Path.home()
        / "Library/Application Support/com.miyazaki.mycmux.e2e/profiles"
        / app.profile
    )
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{time.monotonic_ns() % 1_000_000:06d}"
    for role, directory in (("data", data_dir), ("runtime", app.runtime_dir)):
        if directory.exists():
            QUARANTINE.mkdir(parents=True, exist_ok=True)
            shutil.move(str(directory), str(QUARANTINE / f"profile-{app.profile}-{role}-{stamp}"))
    app.launch()


def stop(app: App) -> None:
    if not app.pids():
        return
    try:
        app.terminate()
        app.wait_exit(15)
    except E2eError:
        app.kill()
        time.sleep(1)


def workspace_names(data: dict[str, Any]) -> list[str]:
    return [workspace["name"] for workspace in data.get("workspaces", [])]


def new_workspace(app: App, name: str, grid: str = "2x1") -> dict[str, Any]:
    return app.call("workspace.new", {"name": name, "cwd": str(Path.home()), "grid": grid})


def detach_first_tab(app: App, workspace_id: str, x: int = 700, y: int = 300) -> None:
    workspace = next(w for w in app.workspaces() if w["id"] == workspace_id)
    pane = workspace["panes"][0]
    tab = pane["tabs"][0]
    app.eval(
        "window.__mycmuxE2E.detachTab(%s, %s, %s, %d, %d); return true;"
        % (json.dumps(workspace_id), json.dumps(pane["id"]), json.dumps(tab["id"]), x, y)
    )


def wait_visible(app: App, label: str, timeout: float) -> float:
    started = time.monotonic()
    app.wait_until(lambda: (app.window(label) or {}).get("visible"), timeout, f"{label} visible", 0.02)
    return time.monotonic() - started


def answer_close_sheet(app: App) -> list[str]:
    dialogs = app.wait_until(lambda: app.dialogs(), 10, "close confirmation sheet")
    buttons = dialogs[0]["buttons"]
    title = next((candidate for candidate in CLOSE_BUTTON_TITLES if candidate in buttons), None)
    if title is None:
        raise E2eError(f"no close button among {buttons}")
    app.click_dialog(title)
    return buttons


def verdict(name: str, checks: dict[str, tuple[bool, Any]]) -> bool:
    ok = all(passed for passed, _ in checks.values())
    log(
        "verdict",
        scenario=name,
        ok=ok,
        checks={key: {"ok": passed, "detail": detail} for key, (passed, detail) in checks.items()},
    )
    return ok


# ── scenarios ──────────────────────────────────────────────────────────────


def detach_reveal(app: App) -> bool:
    """A tab dropped outside the window shows up as its own window quickly."""
    fresh_start(app)
    workspace = new_workspace(app, "WS-A")
    time.sleep(1.5)
    started = time.monotonic()
    detach_first_tab(app, workspace["workspaceId"])
    app.wait_until(lambda: app.window(DETACHED_LABEL), 5, "detached window created", 0.02)
    created = time.monotonic() - started
    visible = created + wait_visible(app, DETACHED_LABEL, 15)
    focused = bool((app.window(DETACHED_LABEL) or {}).get("focused"))
    log("detach-timing", created_s=round(created, 3), visible_s=round(visible, 3), focused=focused)
    child_workspaces = [w["name"] for w in app.workspaces(DETACHED_LABEL)]
    return verdict(
        "detach_reveal",
        {
            "window shown within 1.5 s": (visible <= 1.5, round(visible, 3)),
            "detached window owns the moved tab": (len(child_workspaces) == 1, child_workspaces),
        },
    )


def close_main_keeps_saved_workspaces(app: App) -> bool:
    """On macOS the main window's close button puts the window away: the panes
    keep running, nothing is erased, and the window comes back."""
    fresh_start(app)
    new_workspace(app, "WS-A")
    second = new_workspace(app, "WS-B")
    time.sleep(2)
    detach_first_tab(app, second["workspaceId"])
    wait_visible(app, DETACHED_LABEL, 15)
    time.sleep(3)
    before = workspace_names(app.data_json())
    sessions_before = app.call("pane.list_all")
    log("saved-before-close", workspaces=before)
    app.window_action("main", "close")
    hidden = app.wait_until(
        lambda: (app.window("main") or {}).get("visible") is False, 10, "main window hidden"
    )
    log("after-close", hidden=bool(hidden), windows=[(w["label"], w["visible"]) for w in app.windows()])
    time.sleep(3)
    after = workspace_names(app.data_json())
    sessions_after = app.call("pane.list_all")
    log("saved-after-close", workspaces=after)
    app.window_action("main", "show")
    shown = app.wait_until(lambda: (app.window("main") or {}).get("visible"), 10, "main window shown")
    stop(app)
    after_quit = workspace_names(app.data_json())
    app.launch()
    time.sleep(4)
    restored = [w["name"] for w in app.workspaces()] if app.window("main") else []
    log("restored", workspaces=restored, windows=[w["label"] for w in app.windows()])
    return verdict(
        "close_main_keeps_saved_workspaces",
        {
            "close hides the main window": (bool(hidden), hidden),
            "panes keep running": (
                len(sessions_after) == len(sessions_before) and len(sessions_before) > 0,
                (len(sessions_before), len(sessions_after)),
            ),
            "WS-A still saved after the window closed": ("WS-A" in after, after),
            "the window comes back": (bool(shown), shown),
            "WS-A still saved after quit": ("WS-A" in after_quit, after_quit),
            "WS-A restored on relaunch": ("WS-A" in restored, restored),
        },
    )


def cmd_q_restores_everything(app: App) -> bool:
    """Cmd+Q with a detached window open, then relaunch: every workspace is
    back and nothing was dropped on the way out."""
    fresh_start(app)
    new_workspace(app, "WS-A")
    second = new_workspace(app, "WS-B")
    time.sleep(2)
    detach_first_tab(app, second["workspaceId"])
    wait_visible(app, DETACHED_LABEL, 15)
    # Change something right before quitting: the last edit must survive too.
    app.call("workspace.rename", {"workspaceId": second["workspaceId"], "name": "WS-B-renamed"})
    detached_frame = app.window(DETACHED_LABEL) or {}
    app.menu_key("q", ["cmd"], defer_ms=100)
    exit_seconds = app.wait_exit(20)
    saved = workspace_names(app.data_json())
    log("saved-after-cmd-q", workspaces=saved, exit_s=round(exit_seconds, 2))
    app.launch()
    app.wait_until(lambda: app.window(DETACHED_LABEL), 20, "detached window reopened")
    time.sleep(2)
    restored_main = [w["name"] for w in app.workspaces()] if app.window("main") else []
    windows = [w["label"] for w in app.windows()]
    restored_all = list(restored_main)
    for label in windows:
        if label != "main":
            restored_all += [w["name"] for w in app.workspaces(label)]
    reopened = app.window(DETACHED_LABEL) or {}
    same_frame = all(
        abs((reopened.get(key) or 0) - (detached_frame.get(key) or 0)) <= 2
        for key in ("x", "y", "width", "height")
    )
    log(
        "restored",
        main=restored_main,
        windows=windows,
        all=restored_all,
        frame_before={k: detached_frame.get(k) for k in ("x", "y", "width", "height")},
        frame_after={k: reopened.get(k) for k in ("x", "y", "width", "height")},
    )
    return verdict(
        "cmd_q_restores_everything",
        {
            "app quit within 6 s": (exit_seconds <= 6, round(exit_seconds, 2)),
            "WS-A saved": ("WS-A" in saved, saved),
            "last rename saved": ("WS-B-renamed" in saved, saved),
            "detached tab saved": (len(saved) >= 3, saved),
            "WS-A restored in the main window": ("WS-A" in restored_main, restored_main),
            "the detached tab is a window again": (DETACHED_LABEL in windows, windows),
            "the detached tab is not in the main window": (
                len(restored_main) == 2, restored_main,
            ),
            "the window came back where it was": (same_frame, (detached_frame, reopened)),
        },
    )


def hidden_window_keeps_output(app: App) -> bool:
    """Output that arrives while the window is away is still there — and in one
    piece — when it comes back."""
    fresh_start(app)
    workspace = new_workspace(app, "WS-HIDDEN", "1x1")
    spawn = app.call("pane.spawn", {"workspaceId": workspace["workspaceId"], "target": "shell", "split": True})
    session = spawn["sessionId"]
    time.sleep(4)
    app.window_action("main", "hide")
    app.wait_until(lambda: (app.window("main") or {}).get("visible") is False, 10, "main window hidden")
    time.sleep(0.5)
    # Enough lines that the old path (drop, then resync from the scrollback)
    # and the new one (keep the batches) are both exercised.
    app.call("pane.send_text", {"sessionId": session, "text": "for i in $(seq 1 400); do echo line-$i; done\n"})
    time.sleep(4)
    app.window_action("main", "show")
    app.wait_until(lambda: (app.window("main") or {}).get("visible"), 10, "main window shown")
    started = time.monotonic()
    lines = app.wait_until(
        lambda: [row for row in app.call("pane.read", {"sessionId": session, "lines": 40})["lines"] if "line-400" in row],
        15,
        "the last line to reach the screen",
        0.1,
    )
    caught_up = time.monotonic() - started
    screen = app.call("pane.read", {"sessionId": session, "lines": 400})["lines"]
    numbered = [row.strip() for row in screen if row.strip().startswith("line-")]
    in_order = numbered == sorted(numbered, key=lambda row: int(row.split("-")[1]))
    log("hidden-output", caught_up_s=round(caught_up, 3), lines=len(numbered), tail=lines[-1:])
    return verdict(
        "hidden_window_keeps_output",
        {
            "the last line arrived": (bool(lines), lines[-1:] if lines else None),
            "caught up within 3 s": (caught_up <= 3, round(caught_up, 3)),
            "the lines are in order, with none repeated": (in_order and len(set(numbered)) == len(numbered), len(numbered)),
        },
    )


SCENARIOS: dict[str, Callable[[App], bool]] = {
    "detach_reveal": detach_reveal,
    "hidden_window_keeps_output": hidden_window_keeps_output,
    "close_main_keeps_saved_workspaces": close_main_keeps_saved_workspaces,
    "cmd_q_restores_everything": cmd_q_restores_everything,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--profile", default="e2e")
    parser.add_argument("names", nargs="*", default=list(SCENARIOS))
    options = parser.parse_args()
    app = App(options.profile, options.bundle)
    failed = []
    for name in options.names:
        log("scenario", name=name)
        try:
            if not SCENARIOS[name](app):
                failed.append(name)
        except Exception as exc:  # noqa: BLE001 - a crashed scenario is a failed one
            log("scenario-error", name=name, error=f"{type(exc).__name__}: {exc}")
            failed.append(name)
    stop(app)
    log("summary", failed=failed, passed=[n for n in options.names if n not in failed])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
