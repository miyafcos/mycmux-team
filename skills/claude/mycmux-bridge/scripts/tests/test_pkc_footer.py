"""The accepted vim footer gap must not admit ordinary or stale screens."""
from pathlib import Path
import importlib.util
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'mycmux_bridge.py'
spec = importlib.util.spec_from_file_location('pkc_footer_bridge', SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

FOOT = 'Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel'
SINGLE = ['\u2610 Choice', 'Choose one', '\u276f 1. First', '2. Second']


@pytest.mark.parametrize('mode', ['INSERT', 'VISUAL'])
@pytest.mark.parametrize('blank', [[], [''], ['', '   ']])
@pytest.mark.parametrize('wrapped', [False, True])
def test_vim_marker_gap_and_wrapped_footer_are_one_block(mode, blank, wrapped):
    tail = ['Enter to select \u00b7', '\u2191/\u2193 to navigate \u00b7 Esc to cancel'] if wrapped else [FOOT]
    plain = bridge.scan_ask_question(SINGLE + [FOOT])
    found = bridge.scan_ask_question(SINGLE + ['-- ' + mode + ' -- \u00b7', *blank, *tail])
    assert found == plain and found is not None


@pytest.mark.parametrize('marker', ['-- INSERT -- \u00b7 ? for shortcuts', '-- INSERT --'])
def test_ordinary_vim_prompt_with_conversation_options_is_not_an_ask(marker):
    lines = ['Earlier choices:', '\u276f 1. First', '2. Second', FOOT, '', '\u2500' * 24,
             '\u276f ', '\u2500' * 24, marker]
    assert bridge.scan_ask_question(lines) is None


@pytest.mark.parametrize('gap', [[], ['']])
def test_output_after_vim_footer_is_stale(gap):
    assert bridge.scan_ask_question(SINGLE + ['-- INSERT -- \u00b7', '', FOOT,
                                             *gap, 'answer accepted', '$ ']) is None


def test_unsupported_editor_name_and_trailing_output_remain_rejected():
    assert bridge.scan_ask_question(SINGLE + [FOOT + ' \u00b7 ctrl+g to edit in Unknown Editor']) is None
    assert bridge.scan_ask_question(SINGLE + [FOOT + '  Thinking...']) is None
