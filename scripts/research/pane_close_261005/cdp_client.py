"""CDP/own-profile client. Contains no real mouse/keyboard API."""
from __future__ import annotations
import base64
import itertools
import hashlib
import io
import json
from pathlib import Path
import re
import socket
import time
import urllib.request

import websocket
from PIL import Image, ImageStat


def targets(port):
    assert 9380 <= port <= 9389
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=3) as r:
        return json.loads(r.read())


class Page:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, timeout=15, suppress_origin=True)
        self.ids = itertools.count(1)
        self.events = []
        self.capture_directory = None
        self.capture_tag = "unmeasured"
        self.capture_rois = []
        self.capture_viewport = None
        self.frame_number = 0

    def frame(self, params):
        # ACK every CDP frame, including frames outside measured operations.
        self.ws.send(json.dumps({"id":next(self.ids),"method":"Page.screencastFrameAck",
                                 "params":{"sessionId":params["sessionId"]}}))
        if self.capture_directory is None:
            return
        raw = base64.b64decode(params["data"])
        picture = Image.open(io.BytesIO(raw)).convert("RGB")
        self.frame_number += 1
        tag = re.sub(r"[^A-Za-z0-9_-]", "_", self.capture_tag)
        path = self.capture_directory / tag / f"{self.frame_number:06}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        row = {"ordinal":self.frame_number,"tag":self.capture_tag,"file":str(path),
               "received_monotonic":time.monotonic(),"metadata":params.get("metadata"),
               "sha256":hashlib.sha256(raw).hexdigest(),"size":picture.size,"terminal_regions":[]}
        if self.capture_viewport:
            sx, sy = picture.width/self.capture_viewport[0], picture.height/self.capture_viewport[1]
            for roi in self.capture_rois:
                box = tuple(round(value*scale) for value,scale in zip(roi,[sx,sy,sx,sy]))
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue
                grey = picture.crop(box).convert("L")
                histogram = grey.histogram()
                stat = ImageStat.Stat(grey)
                row["terminal_regions"].append({"box":box,"mean":stat.mean[0],
                    "stddev":stat.stddev[0],"dark_fraction":sum(histogram[:25])/(grey.width*grey.height)})
        with (self.capture_directory / "frames.jsonl").open("a",encoding="utf-8",newline="\n") as f:
            f.write(json.dumps(row,ensure_ascii=True)+"\n")

    def capture(self, directory):
        self.capture_directory = directory
        directory.mkdir(parents=True,exist_ok=True)
        self.send("Page.enable")
        self.send("Page.startScreencast",{"format":"jpeg","quality":65,"maxWidth":1200,"maxHeight":800,"everyNthFrame":1})

    def tag(self, name):
        self.capture_tag = name
        if self.capture_directory:
            view = self.js("return {size:[innerWidth,innerHeight],rois:[...document.querySelectorAll('.xterm-screen')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>20&&r.height>20).map(r=>[r.left,r.top,r.right,r.bottom])};")
            self.capture_rois, self.capture_viewport = view["rois"], view["size"]

    def send(self, method, params=None, timeout=20):
        key = next(self.ids)
        self.ws.send(json.dumps({"id": key, "method": method, "params": params or {}}))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.ws.settimeout(max(.1, deadline-time.monotonic()))
            result = json.loads(self.ws.recv())
            if result.get("id") == key:
                if "error" in result: raise RuntimeError(f"{method}: {result['error']}")
                return result.get("result", {})
            if result.get("method") == "Page.screencastFrame":
                self.frame(result["params"])
            elif result.get("method"):
                self.events.append(result)
        raise TimeoutError(method)

    def eval(self, expr, timeout=25):
        r = self.send("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True,
                                           "timeout": int(timeout*1000)}, timeout+3)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise RuntimeError(d.get("exception", {}).get("description") or d.get("text"))
        return r.get("result", {}).get("value")

    def js(self, body, timeout=25):
        return self.eval("(async()=>{" + body + "})()", timeout)

    def shot(self, path):
        data = self.send("Page.captureScreenshot", {"format":"png"})["data"]
        path.write_bytes(base64.b64decode(data))

    def close(self):
        self.ws.close()


def page(port, label="main"):
    for target in targets(port):
        if target.get("type") != "page" or not target.get("url", "").startswith("http://tauri.localhost"):
            continue
        p = Page(target["webSocketDebuggerUrl"])
        actual = p.eval("window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label")
        if actual == label:
            return p
        p.close()
    raise RuntimeError("CDP app target missing: " + label)


def own_call(profile, cmd, args=None, timeout=15):
    assert re.fullmatch(r"s5[A-Za-z0-9_-]{1,60}", profile)
    runtime = Path.home() / f".mycmux-{profile}"
    # Test-only credential is read for authentication and is never written to evidence or stdout.
    port = int((runtime / "mycmux.port").read_text().strip())
    token = (runtime / "mycmux.token").read_text().strip()
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as c:
        c.settimeout(timeout)
        c.sendall((json.dumps({"cmd": cmd, "args": args or {}, "token": token})+"\n").encode("utf-8"))
        with c.makefile("rb") as r:
            response = json.loads(r.readline())
    if response.get("error") is not None:
        raise RuntimeError(cmd + ": " + str(response["error"]))
    return response.get("result")


def ready(port, profile, timeout=50):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            p = page(port)
            if p.js("return await window.__TAURI_INTERNALS__.invoke('get_test_profile');") != profile:
                p.close(); raise RuntimeError("profile mismatch")
            return p
        except Exception as exc:
            last = str(exc); time.sleep(.5)
    raise RuntimeError("CDP readiness: " + str(last))
