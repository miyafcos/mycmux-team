#!/usr/bin/python3
"""Offline stdio fixture. No model, credentials, network or session-file writes."""
import json
import os
import sys

VERSION = "0.2.0-rc.2"
SESSION = "fixture/session:opaque"
if sys.argv[1:] == ["--version"]:
    print(VERSION)
    sys.exit(0)
if sys.argv[1:] != ["acp"]:
    sys.exit(2)

pending = None


def send(frame):
    print(json.dumps(dict(jsonrpc="2.0", **frame)), flush=True)


def result(request_id, value):
    send(dict(id=request_id, result=value))


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    params = request.get("params", {})
    request_id = request.get("id")
    if method == "initialize":
        result(request_id, dict(protocolVersion=1, agentInfo=dict(version="0.0.1"),
                                agentCapabilities=dict(sessionCapabilities=dict(close={}, list={}, resume={})), authMethods=[]))
    elif method == "session/new":
        result(request_id, dict(sessionId=SESSION, cwd=os.getcwd()))
    elif method == "session/list":
        result(request_id, dict(sessions=[dict(sessionId=SESSION, cwd=os.getcwd())]))
    elif method == "session/resume":
        result(request_id, dict(configOptions=[]))
    elif method == "session/prompt":
        text = params["prompt"][0]["text"]
        if text == "eof":
            sys.exit(0)
        pending = request_id
        if text == "permission":
            send(dict(id=77, method="session/request_permission", params=dict(sessionId=SESSION,
                 toolCall=dict(rawInput="sk-fixture-private"), options=[
                     dict(optionId="allow-once", kind="allow_once", name="private name"),
                     dict(optionId="reject-once", kind="reject_once", name="private name")])) )
        elif text != "cancel":
            reply = "fixture reply"
            if text == "environment":
                forbidden = any(key.upper().startswith(("MYCMUX_", "__CMUX_", "CLAUDE", "CODEX_"))
                                or any(word in key.upper() for word in ("API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"))
                                for key in os.environ)
                reply = "isolation failed" if forbidden else "isolation clean"
            send(dict(method="session/update", params=dict(sessionId=SESSION,
                      update=dict(sessionUpdate="agent_message_chunk", content=dict(type="text", text=reply)))))
            result(pending, dict(stopReason="end_turn"))
            pending = None
    elif method == "session/cancel":
        if pending is not None:
            result(pending, dict(stopReason="cancelled"))
            pending = None
    elif method == "session/close":
        if pending is not None:
            result(pending, dict(stopReason="cancelled"))
            pending = None
        result(request_id, {})
    elif request_id == 77 and "result" in request and pending is not None:
        result(pending, dict(stopReason="end_turn"))
        pending = None
    else:
        send(dict(id=request_id, error=dict(code=-32601, message="unsupported fixture method")))
