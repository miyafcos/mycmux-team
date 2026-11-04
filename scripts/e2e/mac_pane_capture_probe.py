"""Stage-1 capture evidence, using only fresh synthetic e2e profiles.

Stdlib only. Never connects to an existing profile, reads production settings,
or records real terminal contents. The images on disk belong to this fixture.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import plistlib
import signal
import statistics
import struct
import subprocess
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mycmux_e2e import App, E2eError

ROOT = Path(__file__).resolve().parents[2]
IDENTIFIER = "com.miyazaki.mycmux.e2e.capture261104"
FONT = "'UDEV Gothic NF', 'BIZ UDGothic', ui-monospace, 'MS Gothic', monospace"
FRAME = (
    "\x1b[?25l\x1b[0m\x1b[2J\x1b[H"
    "┌──────────────────────────────────────────┐\r\n"
    "│ サンプル企画  北斗学院  CAPTURE FIXTURE    │\r\n"
    "└──────────────────────────────────────────┘\r\n\r\n"
    "    indented text / 日本語 / 🧪 / e\u0301\r\n"
    "\x1b[1mBOLD\x1b[0m \x1b[2mDIM\x1b[0m \x1b[3mITALIC\x1b[0m \x1b[4mUNDERLINE\x1b[0m\r\n"
    "\x1b[7mINVERSE\x1b[0m \x1b[9mSTRIKE\x1b[0m\r\n"
    "\x1b[38;5;201m256 COLOR\x1b[0m \x1b[38;2;23;170;230mRGB\x1b[0m DEFAULT\r\n"
    "\x1b[48;5;25m            \x1b[0m background spaces\r\n"
    "\x1b[31m- removed synthetic line\x1b[0m\r\n"
    "\x1b[32m+ added synthetic line\x1b[0m\r\n\r\n"
    "  Stopped fixture. No project or person data.\x1b[15;4H\x1b[?25h"
)
FIXTURE_PROGRAM = (
    "import os,signal,sys,tty\n"
    "tty.setraw(sys.stdin.fileno())\n"
    f"frame={FRAME!r}.encode('utf-8')\n"
    "def draw(*args): os.write(1,frame)\n"
    "signal.signal(signal.SIGWINCH,draw)\n"
    "draw()\n"
    "while os.read(0,1): pass\n"
)


def error_word(error: BaseException) -> str:
    """Only fixed error vocabulary, never arbitrary socket bodies or stacks."""
    text = str(error)
    for word in ("pane.capture busy", "pane.capture timeout", "pane.capture unavailable",
                 "pane read lifetime changed", "no terminal buffer for session", "PTY read generation changed",
                 "PTY scrollback delta requires a full snapshot"):
        if word in text:
            return word
    for trigger, word in (("fixture geometry", "fixtureGeometryTimeout"), ("stopped fixture screen", "fixtureScreenTimeout"),
                          ("fixture mount", "fixtureMountTimeout"), ("capture owner window", "ownerWindowTimeout"),
                          ("owner fixture adoption", "ownerAdoptionTimeout"), ("owner capture hooks", "ownerHooksTimeout"),
                          ("e2e.window", "windowActionFailed"), ("TypeError", "fixtureTypeError"),
                          ("ReferenceError", "fixtureReferenceError"), ("SyntaxError", "fixtureSyntaxError"),
                          ("This API only accepts", "fixtureInvalidDimensions"),
                          ("can only be set in the constructor", "fixtureReadonlyOption"),
                          ("write data discarded", "fixtureWriteDiscarded"), ("Terminal must be opened", "fixtureNotOpened"),
                          ("allowProposedApi", "fixtureProposedApiDisabled"), ("fixture tab missing", "fixtureTabMissing"),
                          ("Frontend response timed out", "frontendResponseTimeout"), ("Frontend dropped", "frontendDroppedRequest"),
                          ("not a known pane", "fixtureSessionMissing"),
                          ("fixture screen read", "fixtureReadTimeout"),
                          ("capture contract mismatch", "captureContractMismatch"), ("DPR outside", "unsupportedDpr")):
        if trigger in text:
            return word
    for command in ("e2e.eval", "pane.screen", "workspace.new", "pane.spawn_tab"):
        if text.startswith(command + ":"):
            return command + " failed"
    return type(error).__name__


def png_read(data: bytes) -> tuple[int, int, bytes]:
    """Decode the 8-bit RGB/RGBA PNGs emitted by canvas and WKSnapshot."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG signature")
    offset, packed, palette, transparency = 8, bytearray(), b"", b""
    width = height = depth = kind = interlace = 0
    while offset < len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        name = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + size]
        if name == b"IHDR":
            width, height, depth, kind, _, _, interlace = struct.unpack(">IIBBBBB", payload)
        elif name == b"IDAT":
            packed.extend(payload)
        elif name == b"PLTE":
            palette = payload
        elif name == b"tRNS":
            transparency = payload
        offset += size + 12
        if name == b"IEND":
            break
    if depth != 8 or interlace != 0 or kind not in (0, 2, 3, 4, 6):
        raise ValueError("PNG encoding unsupported")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[kind]
    stride = width * channels
    raw = zlib.decompress(packed)
    previous = bytearray(stride)
    rgba = bytearray(width * height * 4)
    for y in range(height):
        pos = y * (stride + 1)
        mode, row = raw[pos], bytearray(raw[pos + 1:pos + stride + 1])
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            above = previous[x]
            diagonal = previous[x - channels] if x >= channels else 0
            if mode == 1:
                predictor = left
            elif mode == 2:
                predictor = above
            elif mode == 3:
                predictor = (left + above) // 2
            elif mode == 4:
                p = left + above - diagonal
                distances = (abs(p - left), abs(p - above), abs(p - diagonal))
                predictor = (left, above, diagonal)[distances.index(min(distances))]
            elif mode == 0:
                predictor = 0
            else:
                raise ValueError("PNG filter")
            row[x] = (row[x] + predictor) & 255
        if kind == 6:
            rgba[y * width * 4:(y + 1) * width * 4] = row
        else:
            for x in range(width):
                cell = row[x * channels:(x + 1) * channels]
                if kind == 2:
                    pixel = bytes(cell) + b"\xff"
                elif kind == 0:
                    pixel = bytes([cell[0]] * 3 + [255])
                elif kind == 4:
                    pixel = bytes([cell[0]] * 3 + [cell[1]])
                else:
                    index = cell[0]
                    pixel = palette[index * 3:index * 3 + 3] + bytes([transparency[index] if index < len(transparency) else 255])
                start = (y * width + x) * 4
                rgba[start:start + 4] = pixel
        previous = row
    return width, height, bytes(rgba)


def png_write(path: Path, width: int, height: int, rgba: bytes) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)
    stride = width * 4
    scanlines = b"".join(b"\0" + rgba[y * stride:(y + 1) * stride] for y in range(height))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


def pixel_diff(live: bytes, capture: bytes, path: Path) -> dict[str, Any]:
    lw, lh, left = png_read(live)
    rw, rh, right = png_read(capture)
    result: dict[str, Any] = {"liveSize": [lw, lh], "captureSize": [rw, rh]}
    if (lw, lh) != (rw, rh):
        result.update(comparable=False, error="dimensionsDiffer")
        return result
    mismatched, maximum = 0, 0
    bounds = [lw, lh, -1, -1]
    diff = bytearray(lw * lh * 4)
    for pixel in range(lw * lh):
        start = pixel * 4
        delta = [abs(left[start + c] - right[start + c]) for c in range(4)]
        maximum = max(maximum, *delta)
        if any(delta):
            mismatched += 1
            x, y = pixel % lw, pixel // lw
            bounds = [min(bounds[0], x), min(bounds[1], y), max(bounds[2], x), max(bounds[3], y)]
            diff[start:start + 4] = bytes([255, max(delta), 255, 255])
        else:
            diff[start:start + 4] = b"\x00\x00\x00\xff"
    png_write(path, lw, lh, bytes(diff))
    result.update(comparable=True, totalPixels=lw * lh, mismatchedPixels=mismatched,
                  matchingPixelRatio=1 - mismatched / (lw * lh), maximumChannelDelta=maximum,
                  mismatchBounds=bounds if mismatched else None, diff=path.name)
    return result


def snapshot_crop(app: App, out: Path, stem: str, live: dict[str, Any]) -> dict[str, Any]:
    path = out / f"snapshot-{stem}.png"
    app.snapshot(path)
    width, height, pixels = png_read(path.read_bytes())
    rect, viewport = live["rect"], live["viewport"]
    sx, sy = width / viewport["width"], height / viewport["height"]
    x, y = max(0, round(rect["x"] * sx)), max(0, round(rect["y"] * sy))
    right, bottom = min(width, round((rect["x"] + rect["width"]) * sx)), min(height, round((rect["y"] + rect["height"]) * sy))
    if right <= x or bottom <= y:
        raise ValueError("snapshot grid outside viewport")
    cropped = b"".join(pixels[(row * width + x) * 4:(row * width + right) * 4] for row in range(y, bottom))
    name = f"snapshot-crop-{stem}.png"
    png_write(out / name, right - x, bottom - y, cropped)
    return {"path": name, "width": right - x, "height": bottom - y,
            "clipped": right - x != round(rect["width"] * sx) or bottom - y != round(rect["height"] * sy)}


def stop(app: App) -> None:
    if not app.pids():
        return
    try:
        app.terminate()
        app.wait_exit(15)
    except Exception:
        for pid in app.pids():
            command = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
            if not command.startswith(f"{app.binary} --profile {app.profile}"):
                raise E2eError("refusing unrelated process")
            os.kill(pid, signal.SIGKILL)
        app.wait_exit(10)


def memory(app: App) -> dict[str, Any]:
    roots = app.pids()
    renderer = app.call("e2e.renderer", {"label": "main", "action": "inspect"})["pid"]
    def rss(pids: list[int]) -> int:
        if not pids:
            raise E2eError("missing owned process")
        return sum(int(value) for value in subprocess.check_output(
            ["ps", "-p", ",".join(map(str, pids)), "-o", "rss="], text=True).split())
    return {"appRssKiB": rss(roots), "webContentRssKiB": rss([renderer]),
            "capture": app.eval("return window.__mycmuxE2E.captureProbe.state();")}


def diagnostic(app: App) -> dict[str, Any]:
    try:
        return app.eval("return window.__mycmuxE2E.captureProbe.state();")
    except Exception as error:
        return {"error": error_word(error)}


def selection(app: App, label: str = "main") -> dict[str, Any]:
    return app.eval("""const h=window.__mycmuxE2E,s=h.stores.workspaceList.getState();
      return {workspace:s.activeWorkspaceId,session:h.stores.ui.getState().activePaneId,
      focusRevision:h.stores.ui.getState().focusRevision,
      tabs:s.workspaces.flatMap(w=>w.panes.map(p=>[p.id,p.activeTabId])),
      viewports:[...h.terminals.live].map(([id,t])=>[id,t.buffer.active.viewportY,t.getSelectionPosition()??null])};""", label)


def activate(app: App, session: str, label: str = "main") -> None:
    app.eval("""const h=window.__mycmuxE2E,sid=""" + json.dumps(session) + """;
      for(const w of h.stores.workspaceList.getState().workspaces)for(const p of w.panes){
        const t=p.tabs.find(t=>t.sessionId===sid);if(t){h.stores.workspaceList.getState().setActiveWorkspace(w.id);
          h.stores.layout.getState().setActivePaneTab(w.id,p.id,t.id);h.stores.ui.getState().setActivePaneId(sid);return true;}}
      throw new Error('fixture tab missing');""", label)
    # Keep the disposable reference at the specified 80x24 reader geometry.
    # macOS may unocclude an accessory window during the long idle sample;
    # without this constraint its normal fit can silently grow to ~171x45.
    # Constrain only this fixture's DOM container. The app's ordinary fit/PTY
    # synchronization then keeps the same grid even on minimize/restore.
    app.wait_until(lambda: app.eval("""const t=window.__mycmuxE2E.terminals.live.get(""" + json.dumps(session) + """);
      const host=t?.element?.parentElement,d=t?._core?._renderService?.dimensions?.css?.cell;
      if(!host||!d?.width||!d?.height)return false;
      const width=Math.ceil(80*d.width)+14,height=Math.ceil(24*d.height);
      Object.assign(host.style,{width:width+'px',minWidth:width+'px',maxWidth:width+'px',
        height:height+'px',minHeight:height+'px',maxHeight:height+'px'});
      return true;""", label), 15, "fixture mount")


def size_fixture(app: App, session: str, cols: int, rows: int, label: str = "main") -> dict[str, Any]:
    """Mode b (mother-seat round-2 note): compare at real reader geometry.

    Prepare the same synthetic frame in the live reference without waiting for
    the occluded window's disabled fit/paint path. Requested geometry is used
    only by the read-only capture-function timing hook below.
    """
    activate(app, session, label)
    # Activation may start a real PTY size revision. Wait for a successful
    # read-only screen acquisition instead of treating that preparation race
    # as a capture failure. The subsequent capture still gets no retries.
    source = app.wait_until(lambda: app.call("pane.screen", {"sessionId": session, "scrollback": 0}),
                            15, "fixture screen read")
    geometry = app.eval("""const t=window.__mycmuxE2E.terminals.live.get(""" + json.dumps(session) + """);
      let phase='lookup';try {
        phase='reset';t.reset();phase='resize';t.resize(""" + str(source["cols"]) + "," + str(source["rows"]) + """);
        phase='write';t._core.writeSync(""" + json.dumps(FRAME) + """);
        phase='blur';t.blur();phase='selection';t.clearSelection();
        return {mode:'b',comparisonCols:t.cols,comparisonRows:t.rows,
          visibility:document.visibilityState,hidden:document.hidden};
      } catch(error) {return {failure:phase,errorKind:error.name};}""", label)
    if "failure" in geometry:
        raise E2eError("fixture frame " + geometry["failure"] + " " + geometry["errorKind"])
    geometry.update(timingCols=cols, timingRows=rows)
    return geometry


def capture(app: App, session: str, scale: str | int, dimensions: tuple[int, int] | None = None,
            label: str = "main") -> tuple[dict[str, Any], bytes]:
    before = [selection(app)] + ([selection(app, label)] if label != "main" else [])
    if dimensions is None:
        reply = app.call("pane.capture", {"sessionId": session, "scale": scale})
    else:
        # e2e.eval otherwise reduces a rejected JS promise to a generic bridge
        # error. Carry only the fixed capture vocabulary, never its payload.
        envelope = app.eval("try{return {captureResult:await window.__mycmuxE2E.captureProbe.measure(" + json.dumps(session)
            + f",{dimensions[0]},{dimensions[1]}," + json.dumps(scale) + ")};}catch(error){"
            + "return {captureError:['pane.capture busy','pane.capture timeout','pane.capture unavailable',"
            + "'pane read lifetime changed'].includes(error?.message)?error.message:'pane.capture unavailable'};}", label)
        if "captureError" in envelope:
            raise E2eError(envelope["captureError"])
        reply = envelope["captureResult"]
    after = [selection(app)] + ([selection(app, label)] if label != "main" else [])
    image = reply["image"]
    png = base64.b64decode(image["data"], validate=True)
    screen = app.call("pane.screen", {"sessionId": session, "scrollback": 0})
    expected = screen if dimensions is None else {**screen, "cols": dimensions[0], "rows": dimensions[1],
        "lines": [screen["lines"][row] if row < len(screen["lines"]) else [] for row in range(dimensions[1])]}
    info = {"source": "socket" if dimensions is None else "capture-function", "scale": image["scale"], "native": image["native"], "elapsedMs": reply["elapsedMs"], "pngBytes": len(png), "width": image["width"], "height": image["height"],
            "screenMatches": expected == reply["screen"], "readOnly": before == after,
            "responseBytes": len((json.dumps({"id": 0, "result": reply, "error": None}, ensure_ascii=False, separators=(",", ":")) + "\n").encode()),
            "renderPath": app.eval("return window.__mycmuxE2E.captureProbe.state().renderPath;", label),
            "scalePath": app.eval("return window.__mycmuxE2E.captureProbe.state().render?.scalePath;", label)}
    if image["type"] != "image/png" or (scale != "native" and image["scale"] != scale) or not info["readOnly"] or not info["screenMatches"]:
        raise E2eError("capture contract mismatch")
    return info, png


def distribution(samples: list[dict[str, Any]]) -> dict[str, Any]:
    times = sorted(row["elapsedMs"] for row in samples)
    if not times:
        return {"count": 0}
    return {"count": len(times), "medianMs": statistics.median(times), "p95Ms": times[math.ceil(len(times) * .95) - 1],
            "maximumMs": max(times), "pngBytesMin": min(row["pngBytes"] for row in samples),
            "pngBytesMax": max(row["pngBytes"] for row in samples)}


def prepare_memory(app: App, session: str, other: str, other_ws: str, progress: dict[str, Any]) -> None:
    """Identical setup in capture and no-capture profiles, before point (i)."""
    for cols, rows in ((120, 40), (62, 48)):
        progress["stage"] = f"memory-prepare-{cols}x{rows}-frame"
        size_fixture(app, session, cols, rows)
        progress["stage"] = f"memory-prepare-{cols}x{rows}-tabs"
        activate(app, other)
        progress["stage"] = f"memory-prepare-{cols}x{rows}-workspace"
        app.eval("window.__mycmuxE2E.stores.workspaceList.getState().setActiveWorkspace(" + json.dumps(other_ws) + ");return true;")
        progress["stage"] = f"memory-prepare-{cols}x{rows}-return"
        activate(app, session)
    # Minimize belongs to the later visibility matrix. Unminimizing here can
    # show an accessory window and trigger a real fit before memory point (i).
    # The no-capture control repeats precisely this same preparation.
    activate(app, session)


def settings_probe(app: App, session: str, out: Path, preset: str) -> dict[str, Any]:
    """Change the disposable live xterm's applied options, then use the socket.

    The same live options are the capture/headless appearance source. Nothing
    in the production stores or the operator's profile is altered by this test.
    """
    activate(app, session)
    app.eval("""const t=window.__mycmuxE2E.terminals.live.get(""" + json.dumps(session) + """);
      t.options={fontFamily:'"HackGen Console NF", monospace',fontSize:16,lineHeight:1.5,
        fontWeight:400,fontWeightBold:800,letterSpacing:1,minimumContrastRatio:4,
        theme:{...t.options.theme,foreground:'#dce4ef',background:'#171922',cursor:'#ffcc66'}};
      t.element.style.setProperty('font-feature-settings','"liga" 0');
      await Promise.all([400,800].map(w=>document.fonts.load(w+' 16px "HackGen Console NF"')));
      t._core._charSizeService.measure();t._core._renderService._renderer.value.handleResize(t.cols,t.rows);
      return true;""")
    live = app.eval("return await window.__mycmuxE2E.captureProbe.live(" + json.dumps(session) + ");")
    live_png = base64.b64decode(live["image"]["data"], validate=True)
    info, png = capture(app, session, "native")
    (out / f"settings-live-{preset}.png").write_bytes(live_png)
    (out / f"settings-capture-{preset}.png").write_bytes(png)
    pixel = pixel_diff(live_png, png, out / f"settings-diff-{preset}.png")
    return {**info, "options": live["options"], "pixels": pixel,
            "ok": pixel.get("comparable") and pixel.get("mismatchedPixels") == 0}


def peer_probe(app: App, session: str, out: Path, preset: str) -> dict[str, Any]:
    """Move the fixture with the shipped tearout path; request from main."""
    activate(app, session)
    previous = {window["label"] for window in app.windows()}
    app.eval("""const h=window.__mycmuxE2E,sid=""" + json.dumps(session) + """;
      for(const w of h.stores.workspaceList.getState().workspaces)for(const p of w.panes){
        const t=p.tabs.find(t=>t.sessionId===sid);if(t){h.detachTab(w.id,p.id,t.id,700,300);return true;}}
      throw new Error('fixture missing');""")
    owner = app.wait_until(lambda: next((window["label"] for window in app.windows() if window["label"] not in previous), None), 20, "capture owner window")
    app.wait_until(lambda: app.eval("return !!window.__mycmuxE2E?.captureProbe;", owner), 20, "owner capture hooks")
    app.wait_until(lambda: any(tab["sessionId"] == session for workspace in app.workspaces(owner)
        for pane in workspace["panes"] for tab in pane["tabs"]), 20, "owner fixture adoption")
    app.eval("window.__mycmuxE2E.stores.settings.getState().setTerminalRenderer('webgl');return true;", owner)
    size_fixture(app, session, 120, 40, owner)
    time.sleep(.5)
    live = app.eval("return await window.__mycmuxE2E.captureProbe.live(" + json.dumps(session) + ");", owner)
    info, png = capture(app, session, "native", label=owner)
    live_png = base64.b64decode(live["image"]["data"], validate=True)
    (out / f"peer-live-{preset}.png").write_bytes(live_png)
    (out / f"peer-capture-{preset}.png").write_bytes(png)
    pixel = pixel_diff(live_png, png, out / f"peer-diff-{preset}.png")
    return {**info, "owner": owner, "pixels": pixel,
            "ok": pixel.get("comparable") and pixel.get("mismatchedPixels") == 0}


def load_probe(app: App, session: str, seconds: float, idle_seconds: float,
               scales: tuple[str | int, ...] = ("native",)) -> dict[str, Any]:
    """Five real minutes of serial socket captures at the requested scales.

    Isolate this from the functional/memory-control profiles. Sampling uses
    monotonic wall time and ps RSS, never WebKit's throttled frame clock.
    """
    started = time.monotonic()
    result: dict[str, Any] = {"requestedSeconds": seconds, "requestedCapturesPerSecond": 6,
        "scales": list(scales), "attempts": 0, "successes": 0, "errorCount": 0, "errors": [],
        "rss": [{"seconds": 0, **memory(app)}], "byScale": {}}
    next_sample = 30.0
    while time.monotonic() - started < seconds:
        elapsed = time.monotonic() - started
        if elapsed >= next_sample:
            result["rss"].append({"seconds": elapsed, **memory(app)})
            print(json.dumps({"loadSeconds": round(elapsed, 1), "captures": result["successes"],
                              "webContentRssKiB": result["rss"][-1]["webContentRssKiB"]}), flush=True)
            next_sample += 30
        scale = scales[result["attempts"] % len(scales)]
        result["attempts"] += 1
        capture_started = time.monotonic()
        try:
            info, _ = capture(app, session, scale)
            result["successes"] += 1
            bucket = result["byScale"].setdefault(str(scale), {"count": 0, "totalMs": 0, "maximumMs": 0})
            bucket["count"] += 1
            bucket["totalMs"] += info["elapsedMs"]
            bucket["maximumMs"] = max(bucket["maximumMs"], info["elapsedMs"])
        except Exception as error:
            result["errorCount"] += 1
            if len(result["errors"]) < 20:
                result["errors"].append({"seconds": time.monotonic() - started, "error": error_word(error)})
        # No catch-up bursts: keep the requested six per second as an upper
        # bound even if a capture or RSS sample itself took longer than 1/6s.
        next_capture = min(started + seconds, capture_started + 1 / 6)
        time.sleep(max(0, next_capture - time.monotonic()))
    result["elapsedSeconds"] = time.monotonic() - started
    result["actualCapturesPerSecond"] = result["successes"] / result["elapsedSeconds"]
    result["rss"].append({"seconds": result["elapsedSeconds"], **memory(app)})
    time.sleep(idle_seconds)
    result["afterIdle"] = {"idleSeconds": idle_seconds, **memory(app)}
    result["ok"] = (result["errorCount"] == 0 and result["successes"] > 0
                    and result["elapsedSeconds"] >= seconds and not result["afterIdle"]["capture"]["allocated"])
    return result


def run_preset(bundle: Path, out: Path, preset: str, samples: int, memory_captures: int, idle_seconds: float,
               control_wait: float | None = None, load_seconds: float = 0,
               load_scales: tuple[str | int, ...] = ("native",)) -> dict[str, Any]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    mode = "control-" if control_wait is not None else "load-" if load_seconds else ""
    app = App(f"capture261104-{preset}-{mode}{stamp}", bundle)
    result: dict[str, Any] = {"preset": preset, "profile": app.profile, "dimensions": [], "status": "PASS"}
    settings = {"font_size": 14 if preset == "default" else 13, "line_height": 1.35 if preset == "default" else 1.1,
                "font_family": FONT, "theme_id": "yoru-cafe" if preset == "default" else "kyokuya",
                "theme_tweaks": {"enabled": False, "colors": {}, "background": {"mode": "solid", "imagePath": ""}},
                "ai_enabled": False, "auto_pane_naming_enabled": False, "auto_workspace_naming_enabled": False,
                "reply_draft_suggestions_enabled": False, "pet_display_mode": "none", "ailog_mirror_full_text_root": None}
    data_dir = Path.home() / "Library/Application Support" / IDENTIFIER / "profiles" / app.profile
    if app.runtime_dir.exists() or data_dir.exists():
        raise E2eError("profile is not fresh")
    data_dir.mkdir(parents=True)
    (data_dir / "data.json").write_text(json.dumps({"schema_version": 1, "workspaces": [], "settings": settings}) + "\n")
    try:
        # App's profile/socket ownership, with tao's existing profile-only
        # accessory policy to keep this test from taking the operator's focus.
        subprocess.run(["open", "-n", "-g", "--env", "MYCMUX_PROFILE_ACTIVATION=accessory", "-a", str(bundle),
                        "--args", "--profile", app.profile], check=True)
        app.wait_until(app._socket_ready, 60, "owned profile socket")
        app.wait_until(lambda: app.eval("return !!window.__mycmuxE2E?.captureProbe;"), 30, "capture hooks")
        if app.eval('return await window.__TAURI_INTERNALS__.invoke("get_test_profile");') != app.profile:
            raise E2eError("profile ownership mismatch")
        version = app.call("system.version")
        if "pane.capture.v1" not in version["capabilities"]:
            raise E2eError("capture capability missing")
        result["settings"] = settings
        result["stage"] = "configure"
        app.eval("""const s=window.__mycmuxE2E.stores.settings.getState();
          s.setTerminalRenderer('webgl');s.setNativePaneTearoutEnabled(false);
          await window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',
            {label:'main',value:{Logical:{width:1500,height:1250}}});return true;""")
        result["stage"] = "fixture"
        workspace = app.call("workspace.new", {"name": "サンプル企画 撮影", "grid": "1x1", "cwd": str(ROOT)})
        anchor = workspace["panes"][0]["sessionId"]
        session = app.call("pane.spawn_tab", {"anchorSessionId": anchor, "activate": False, "label": "Synthetic capture",
                    "commandArgv": ["/usr/bin/python3", "-c", FIXTURE_PROGRAM]})["sessionId"]
        other = app.call("pane.spawn_tab", {"anchorSessionId": session, "activate": False, "label": "Synthetic background",
                    "commandArgv": ["/bin/sh", "-c", "while :; do sleep 60; done"]})["sessionId"]
        other_ws = app.call("workspace.new", {"name": "北斗学院 背景", "grid": "1x1", "cwd": str(ROOT)})["workspaceId"]
        app.wait_until(lambda: any("CAPTURE" in run[2] for line in app.call("pane.screen", {"sessionId": session})["lines"] for run in line), 15, "stopped fixture screen")
        prepare_memory(app, session, other, other_ws, result)
        result["stage"] = "isolated-memory"
        result["memory"] = {"iBeforeFirst": memory(app), "control": control_wait is not None}
        started = time.monotonic()
        if control_wait is not None:
            time.sleep(control_wait)
            result["memory"].update(vControlAtIdle=memory(app), waitSeconds=control_wait)
            if result["memory"]["vControlAtIdle"]["capture"]["captures"] != 0:
                raise E2eError("control unexpectedly captured")
            result["stage"] = "complete"
            return result
        if load_seconds:
            result["stage"] = "five-minute-load"
            result["load"] = load_probe(app, session, load_seconds, idle_seconds, load_scales)
            if not result["load"]["ok"]:
                result["status"] = "FAIL"
            result["stage"] = "complete"
            return result
        first, _ = capture(app, session, "native")
        result["memory"].update(firstCapture=first, iiAfterFirst=memory(app))
        successes, errors = 1, []
        for _ in range(memory_captures - 1):
            try:
                capture(app, session, "native"); successes += 1
            except Exception as error:
                errors.append({"error": error_word(error), "diagnostic": diagnostic(app)})
        result["memory"].update(captureCount=successes, errors=errors, iiiAfter100=memory(app))
        time.sleep(idle_seconds)
        result["memory"].update(ivAfterIdle=memory(app), idleSeconds=idle_seconds,
                                 controlWaitSeconds=time.monotonic() - started)
        if errors or result["memory"]["ivAfterIdle"]["capture"]["allocated"]:
            result["status"] = "FAIL"
        for cols, rows in ((120, 40), (62, 48)):
            stem = f"{preset}-{cols}x{rows}"
            row: dict[str, Any] = {"cols": cols, "rows": rows, "timings": [], "visibility": []}
            result["dimensions"].append(row)
            try:
                result["stage"] = f"measure-{cols}x{rows}"
                row["geometry"] = size_fixture(app, session, cols, rows)
                live = app.eval("return await window.__mycmuxE2E.captureProbe.live(" + json.dumps(session) + ");")
                row["live"] = {key: value for key, value in live.items() if key != "image"}
                live_png = base64.b64decode(live["image"]["data"], validate=True)
                (out / f"live-{stem}.png").write_bytes(live_png)
                dpr = live["dpr"]
                row["fractionalDpr"] = "Mac e2e uses actual DPR; 1.5 requires the stage-1 Windows probe"
                row["cold"] = {"allocatedBefore": app.eval("return window.__mycmuxE2E.captureProbe.state().allocated;")}
                try:
                    info, png = capture(app, session, "native")
                    row["cold"].update(info)
                    (out / f"capture-{stem}-native.png").write_bytes(png)
                    row["pixels"] = pixel_diff(live_png, png, out / f"diff-{stem}.png")
                except Exception as error:
                    row["cold"].update(error=error_word(error), diagnostic=diagnostic(app))
                    result["status"] = "FAIL"
                row["snapshot"] = snapshot_crop(app, out, stem, live)
                for scale in ("native", 1, 2):
                    sample_row: dict[str, Any] = {"scale": scale, "samples": [], "errors": []}
                    row["timings"].append(sample_row)
                    # First call at each geometry/scale is separate from 30 timed calls.
                    try:
                        sample_row["first"], png = capture(app, session, scale, (cols, rows))
                        (out / f"capture-{stem}-s{scale}.png").write_bytes(png)
                    except Exception as error:
                        sample_row["first"] = {"error": error_word(error), "diagnostic": diagnostic(app)}
                        result["status"] = "FAIL"
                    for _ in range(samples):
                        # Match the server's maximum six requests per second.
                        # Keep GPU/codec work from a previous sample out of the
                        # next sample's deadline; elapsedMs excludes this gap.
                        # The isolated 100-capture burst remains unchanged.
                        time.sleep(1 / 6)
                        try:
                            info, _ = capture(app, session, scale, (cols, rows))
                            sample_row["samples"].append(info)
                        except Exception as error:
                            sample_row["errors"].append({"error": error_word(error), "diagnostic": diagnostic(app)})
                            result["status"] = "FAIL"
                    sample_row["summary"] = distribution(sample_row["samples"])
                    try:
                        sample_row["encodings"] = app.eval("return await window.__mycmuxE2E.captureProbe.encodings("
                            + json.dumps(session) + "," + json.dumps(scale) + f",{cols},{rows});")
                    except Exception as error:
                        sample_row["encodings"] = {"error": error_word(error)}
                        result["status"] = "FAIL"
                for visibility in ("visible", "behind-tab", "inactive-workspace", "minimized"):
                    if visibility == "behind-tab":
                        activate(app, other)
                    elif visibility == "inactive-workspace":
                        app.eval("window.__mycmuxE2E.stores.workspaceList.getState().setActiveWorkspace(" + json.dumps(other_ws) + ");return true;")
                    else:
                        activate(app, session)
                    if visibility == "minimized":
                        app.window_action("main", "minimize")
                    time.sleep(.5)
                    for scale in ("native", 1, 2):
                        time.sleep(1 / 6)
                        status: dict[str, Any] = {"state": visibility, "scale": scale}
                        try:
                            status.update(capture(app, session, scale)[0], ok=True)
                        except Exception as error:
                            status.update(ok=False, error=error_word(error), diagnostic=diagnostic(app)); result["status"] = "FAIL"
                        row["visibility"].append(status)
                    if visibility == "minimized":
                        app.window_action("main", "unminimize")
                        app.window_action("main", "hide")
                if not row.get("pixels", {}).get("comparable") or row["pixels"].get("mismatchedPixels") != 0:
                    result["status"] = "FAIL"
            except Exception as error:
                row["error"] = error_word(error); result["status"] = "FAIL"
                try:
                    observed = app.call("pane.screen", {"sessionId": session, "scrollback": 0})
                    row["observed"] = {"cols": observed["cols"], "rows": observed["rows"],
                        "fixtureReady": any("CAPTURE" in run[2] for line in observed["lines"] for run in line)}
                except Exception as secondary:
                    row["observed"] = {"error": error_word(secondary)}
            print(json.dumps({"preset": preset, "cols": cols, "rows": rows, "status": result["status"]}), flush=True)
        result["stage"] = "changed-settings"
        result["changedSettings"] = settings_probe(app, session, out, preset)
        if not result["changedSettings"]["ok"]:
            result["status"] = "FAIL"
        result["stage"] = "peer-window"
        result["peerWindow"] = peer_probe(app, session, out, preset)
        if not result["peerWindow"]["ok"]:
            result["status"] = "FAIL"
        result["stage"] = "complete"
    except Exception as error:
        result.update(status="FAIL", error=error_word(error))
    finally:
        try:
            stop(app)
            result["remainingPids"] = app.pids()
            if result["remainingPids"]:
                result["status"] = "FAIL"
        except Exception as error:
            result.update(status="FAIL", cleanupError=error_word(error))
    return result


def report(record: dict[str, Any], out: Path) -> None:
    lines = ["# 段1 pane.capture 測定", "", "読者＝母艦と作者／語り手＝測り台本", "",
             f"結果: {record['status']}。画像は使い捨て profile の架空データだけ。", "",
             "全倍率を撮影端末のDPRで描き直してWebGL backing寸法を1:1コピー。Mac実測DPRは1、その他の実窓DPRはWindows比較頁で測る。", "",
             "| 設定 | 寸法 | scale | 初回ms | 中央値ms | p95ms | 最大ms | PNG bytes | WebP | 成功/要求 |",
             "|---|---|---:|---:|---:|---:|---:|---|---|---|"]
    for preset in record["presets"]:
        for row in preset["dimensions"]:
            for timing in row["timings"]:
                summary, first, enc = timing["summary"], timing["first"], timing.get("encodings", {})
                lines.append(f"| {preset['preset']} | {row['cols']}×{row['rows']} | {timing['scale']} | "
                    f"{first.get('elapsedMs', first.get('error'))} | {summary.get('medianMs')} | {summary.get('p95Ms')} | "
                    f"{summary.get('maximumMs')} | {summary.get('pngBytesMin')}–{summary.get('pngBytesMax')} | "
                    f"{enc.get('webpBytes') if enc.get('webpType') == 'image/webp' else enc.get('webpType', enc.get('error'))} | "
                    f"{summary['count']}/{record['samples']} |")
    lines += ["", "## 画素と表示状態", "", "差分図: 黒＝一致、マゼンタ＝差分。座標の数値は probe.json。", ""]
    for preset in record["presets"]:
        for row in preset["dimensions"]:
            stem = f"{preset['preset']}-{row['cols']}x{row['rows']}"
            pixel = row.get("pixels", {})
            lines += [f"### {stem} (寸法は時間測定用、画素比較は実端末の寸法)", "", f"一致率: {pixel.get('matchingPixelRatio')} / 最大チャンネル差: {pixel.get('maximumChannelDelta')} / 差分範囲: {pixel.get('mismatchBounds')}",
                      f"初回（撮影端末の有無を含む）: `{json.dumps(row.get('cold', {}), ensure_ascii=False)}`", "",
                      f"![capture](capture-{stem}-native.png)", f"![live](live-{stem}.png)",
                      f"![snapshot crop](snapshot-crop-{stem}.png)", f"![diff](diff-{stem}.png)", ""]
            if row.get("error"):
                lines += [f"測定誤り: {row['error']}", ""]
            for visibility in row["visibility"]:
                lines.append(f"- {visibility['state']} / scale {visibility['scale']}: "
                             + (f"成功 {visibility['elapsedMs']:.2f}ms ({visibility['renderPath']})" if visibility["ok"] else visibility["error"]))
    lines += ["", "## メモリ (RSS KiB)", ""]
    for preset in record["presets"]:
        lines += [f"### {preset['preset']}", "", "```json", json.dumps(preset.get("memory", {}), indent=2, ensure_ascii=False), "```", "",
                  "設定変更: `" + json.dumps(preset.get("changedSettings", {}), ensure_ascii=False) + "`", "",
                  "別窓: `" + json.dumps(preset.get("peerWindow", {}), ensure_ascii=False) + "`", "",
                  f"終了確認: 残存PID={preset.get('remainingPids')} / 誤り={preset.get('error')} / 終了誤り={preset.get('cleanupError')}", ""]
    if record.get("loads"):
        lines += ["## 最後の5分負荷 (別の新規profile・RSS KiB)", "",
                  "指定scaleを巡回し最大6枚/秒 (標準は従来100枚と同じnative)。実時間30秒ごとと300秒後を測り、その後62秒idleの解放も確認する。頭打ちの採否は母艦の判断。", "",
                  "| 設定 | 経過秒 | app RSS KiB | WebContent RSS KiB | 成功枚数 |", "|---|---:|---:|---:|---:|"]
        for preset in record["loads"]:
            load = preset.get("load", {})
            for point in load.get("rss", []):
                lines.append(f"| {preset['preset']} | {point['seconds']:.1f} | {point['appRssKiB']} | "
                             f"{point['webContentRssKiB']} | {point['capture']['captures']} |")
            lines += ["", f"{preset['preset']} の記録: `{json.dumps(load, ensure_ascii=False)}`", "",
                      f"終了確認: 残存PID={preset.get('remainingPids')} / 誤り={preset.get('error')}", ""]
    lines += ["計算: p95 は昇順 ceil(n×.95) 番目、PNG は base64 復号後。WebP は実際の blob.type が image/webp の場合だけバイト数を採用。",
              "母艦の第2回注記の(b)を採用。画素比較と表示状態・100回連続撮影は実際の読取寸法(80×24等)のsocket。120×40・62×48は同じ架空cellsの空き領域だけを変えた読取専用フックから、本物と同じ撮影関数で時間・PNGを測った。visibilityStateの上書きはない。",
              "メモリは同じ準備を済ませてから(i)初回前・(ii)初回後・(iii)合計100枚後・(iv)62秒idle後、別の新規profileで撮影なしの(v)を同じ経過時間で測る。RSS超過は要判断とし、試験を止めない。", "",
              "画素差は差分図・範囲・画素数で示す。設定変更と別窓も差分0を要求する。", ""]
    (out / "PROBE-REPORT.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--memory-captures", type=int, default=100)
    parser.add_argument("--idle-seconds", type=float, default=62)
    parser.add_argument("--load-seconds", type=float, default=0, help="extra fresh profiles for the final >=300s RSS load")
    parser.add_argument("--load-scales", nargs="+", choices=("native", "2"), default=["native"],
                        help="load scales in order: native by default; native 2 reproduces atlas-switching stress")
    args = parser.parse_args()
    if (sys.platform != "darwin" or args.samples < 1 or args.memory_captures < 1 or args.idle_seconds < 60
            or not math.isfinite(args.load_seconds) or args.load_seconds < 0 or 0 < args.load_seconds < 300):
        parser.error("requires macOS, positive counts, >=60 idle seconds, and load disabled or >=300 seconds")
    bundle, out = args.bundle.resolve(), args.out.resolve()
    with (bundle / "Contents/Info.plist").open("rb") as stream:
        identifier = plistlib.load(stream).get("CFBundleIdentifier")
    if identifier != IDENTIFIER or Path("/Applications") in bundle.parents:
        parser.error("requires the dedicated capture261104 e2e bundle")
    if ROOT not in out.parents:
        parser.error("output must stay inside this worktree")
    out.mkdir(parents=True, exist_ok=True)
    record: dict[str, Any] = {"started": datetime.now(timezone.utc).isoformat(), "samples": args.samples,
        "binarySha256": hashlib.sha256((bundle / "Contents/MacOS/mycmux").read_bytes()).hexdigest(), "presets": [], "loads": []}
    for preset in ("default", "pc"):
        measured = run_preset(bundle, out, preset, args.samples, args.memory_captures, args.idle_seconds)
        record["presets"].append(measured)
        metrics = measured.get("memory", {})
        if "controlWaitSeconds" in metrics:
            control = run_preset(bundle, out, preset, args.samples, args.memory_captures, args.idle_seconds, metrics["controlWaitSeconds"])
            measured["memoryControl"] = control
            if control["status"] != "PASS":
                measured["status"] = "FAIL"
            else:
                metrics["vControlAtIdle"] = control["memory"]["vControlAtIdle"]
                growth = (metrics["iiiAfter100"]["webContentRssKiB"] - metrics["iiAfterFirst"]["webContentRssKiB"]) * 1024
                residual = abs(metrics["ivAfterIdle"]["webContentRssKiB"] - metrics["vControlAtIdle"]["webContentRssKiB"]) * 1024
                metrics["acceptance"] = {"growthBytes": growth, "growthUnder10MB": growth < 10_000_000,
                                         "idleControlDifferenceBytes": residual, "idleControlUnder20MB": residual < 20_000_000}
        record["status"] = "PASS" if all(row["status"] == "PASS" for row in record["presets"]) else "FAIL"
        (out / "probe.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        report(record, out)
    if args.load_seconds:
        for preset in ("default", "pc"):
            record["loads"].append(run_preset(bundle, out, preset, args.samples, args.memory_captures,
                                             args.idle_seconds, load_seconds=args.load_seconds,
                                             load_scales=tuple("native" if s == "native" else 2 for s in args.load_scales)))
            record["status"] = "PASS" if all(row["status"] == "PASS" for row in record["presets"] + record["loads"]) else "FAIL"
            (out / "probe.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            report(record, out)
    print(json.dumps({"status": record["status"], "report": str(out / "PROBE-REPORT.md")}), flush=True)
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
