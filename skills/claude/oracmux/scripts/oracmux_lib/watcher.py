"""Answer-completion state machine. Pure Python, no browser.

Ported from the lessons in ultra-deep-research (2026-08-25) and hardened after
the 2026-09-07 audit (F-15 / F-16 / F-17):
- take a baseline before sending and do not start judging until the text
  differs from it (otherwise the echo of our own prompt is saved as the answer)
- "stable" means no generating indicator AND *identical* text (not just the
  same length) for stable_sec AND at least min_wait_sec since sending
- an empty read after the answer appeared is a read failure, never a stable
  empty answer; an echo read after the answer appeared is a DOM re-render,
  never an answer. Both keep the last good body and reset stability
- never wait forever: answer_appear_sec bounds the wait for the first byte,
  overall_sec bounds the whole run
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

STATE_WAITING = "waiting_appear"
STATE_STREAMING = "streaming"
STATE_DONE = "done"
STATE_FAILED = "failed"

DETECT_STABLE = "answer_stable_after_appear"
DETECT_NEVER = "answer_never_appeared"
DETECT_ECHO = "echo_detected"
DETECT_TIMEOUT = "timeout"

ECHO_PREFIX_CHARS = 200


def compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def is_echo(body: str, source: str) -> bool:
    prefix = compact(source)[:ECHO_PREFIX_CHARS]
    return bool(prefix) and prefix in compact(body)


@dataclass
class WatchConfig:
    answer_appear_sec: float
    stable_sec: float
    min_wait_sec: float
    overall_sec: float

    def __post_init__(self) -> None:
        for name in ("answer_appear_sec", "stable_sec", "min_wait_sec", "overall_sec"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")


@dataclass
class AnswerWatcher:
    cfg: WatchConfig
    baseline: str
    echo_sources: list[str]
    sent_at: float
    state: str = STATE_WAITING
    detection: str = ""
    appeared_at: float | None = None
    stable_since: float | None = None
    prev_body: str = ""
    echo_seen: bool = False
    last_body: str = ""  # last *good* body (non-empty, non-echo) once streaming
    bad_reads: int = 0
    trace: list[str] = field(default_factory=list)

    def _is_echo(self, body: str) -> bool:
        return any(is_echo(body, source) for source in self.echo_sources)

    def feed(self, body: str, generating: bool, now: float) -> str:
        if self.state in (STATE_DONE, STATE_FAILED):
            return self.state
        if now - self.sent_at >= self.cfg.overall_sec:
            self.state = STATE_FAILED
            self.detection = DETECT_TIMEOUT
            return self.state
        if self.state == STATE_WAITING:
            echo = self._is_echo(body)
            if body and body != self.baseline and not echo:
                self.state = STATE_STREAMING
                self.appeared_at = now
                self.prev_body = body
                self.last_body = body
                self.stable_since = None
                self.trace.append(f"appeared_after={now - self.sent_at:.0f}s")
                return self.state
            if body and echo:
                self.echo_seen = True
            if now - self.sent_at >= self.cfg.answer_appear_sec:
                self.state = STATE_FAILED
                self.detection = DETECT_ECHO if self.echo_seen else DETECT_NEVER
            return self.state
        # streaming: an empty or echo read is a bad read, not new content
        if not body or self._is_echo(body):
            self.bad_reads += 1
            self.stable_since = None
            return self.state
        self.last_body = body
        if generating or body != self.prev_body:
            self.stable_since = None
        elif self.stable_since is None:
            self.stable_since = now
        elif now - self.stable_since >= self.cfg.stable_sec and now - self.sent_at >= self.cfg.min_wait_sec:
            self.state = STATE_DONE
            self.detection = DETECT_STABLE
            self.trace.append(f"stable_for={now - self.stable_since:.0f}s chars={len(body)} bad_reads={self.bad_reads}")
        self.prev_body = body
        return self.state

    @property
    def finished(self) -> bool:
        return self.state in (STATE_DONE, STATE_FAILED)

    @property
    def timed_out(self) -> bool:
        return self.state == STATE_FAILED and self.detection in (DETECT_TIMEOUT, DETECT_NEVER)
