from __future__ import annotations

import pytest

from oracmux_lib import watcher

PROMPT = "問い: mycmux の Web ペインに oracle を載せる設計は妥当か。" * 4


def make(**overrides):
    cfg = watcher.WatchConfig(answer_appear_sec=60, stable_sec=10, min_wait_sec=15, overall_sec=600)
    values = {"cfg": cfg, "baseline": "", "echo_sources": [PROMPT], "sent_at": 0.0}
    values.update(overrides)
    return watcher.AnswerWatcher(**values)


def test_answer_appears_then_stabilises():
    w = make()
    assert w.feed("", False, 1) == watcher.STATE_WAITING
    assert w.feed("回答の途中", True, 5) == watcher.STATE_STREAMING
    assert w.feed("回答の途中で伸びる", True, 10) == watcher.STATE_STREAMING
    assert w.feed("回答の途中で伸びる", False, 12) == watcher.STATE_STREAMING  # stable_since starts
    assert w.feed("回答の途中で伸びる", False, 18) == watcher.STATE_STREAMING  # min_wait not reached
    assert w.feed("回答の途中で伸びる", False, 23) == watcher.STATE_DONE
    assert w.detection == watcher.DETECT_STABLE
    assert w.last_body == "回答の途中で伸びる"


def test_generating_indicator_resets_stability():
    w = make()
    w.feed("a", False, 1)
    w.feed("a", False, 20)
    assert w.feed("a", True, 29) == watcher.STATE_STREAMING
    assert w.feed("a", False, 35) == watcher.STATE_STREAMING
    assert w.feed("a", False, 46) == watcher.STATE_DONE


def test_baseline_and_echo_are_not_answers():
    w = make(baseline="前の回答")
    assert w.feed("前の回答", False, 1) == watcher.STATE_WAITING
    assert w.feed(PROMPT, False, 2) == watcher.STATE_WAITING
    assert w.echo_seen
    assert w.feed(PROMPT, False, 61) == watcher.STATE_FAILED
    assert w.detection == watcher.DETECT_ECHO


def test_never_appeared_and_overall_timeout():
    w = make()
    assert w.feed("", False, 61) == watcher.STATE_FAILED
    assert w.detection == watcher.DETECT_NEVER
    w2 = make()
    w2.feed("x", False, 1)
    assert w2.feed("x" * 5, True, 601) == watcher.STATE_FAILED
    assert w2.detection == watcher.DETECT_TIMEOUT
    assert w2.feed("x" * 6, False, 602) == watcher.STATE_FAILED  # terminal


def test_config_rejects_non_positive_values():
    with pytest.raises(ValueError):
        watcher.WatchConfig(answer_appear_sec=0, stable_sec=1, min_wait_sec=1, overall_sec=1)


def test_is_echo_uses_compact_prefix():
    assert watcher.is_echo("  問い:  mycmux の Web ペイン" + PROMPT[20:], PROMPT)
    assert not watcher.is_echo("全く別の本文", PROMPT)
    assert not watcher.is_echo("anything", "")
