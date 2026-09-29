import importlib.util
from pathlib import Path


_spec = importlib.util.spec_from_file_location(
    "conpty_producer", Path(__file__).parents[2] / "scripts/perf/conpty-producer.py"
)
producer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(producer)


def test_checks_every_line_after_only_vt_and_crlf_normalization():
    result = producer.validate_seq_stream(b"\x1b[?25l\x1b[2J\x1b[H1\r\n2\r\n3\r\n\x1b[?25h", 3)
    assert result["exactSequence"]
    assert result["normalizedSha256"] == result["expectedSha256"]


def test_rejects_missing_or_repeated_lines_and_cursor_coalescing():
    for raw in [b"1\r\n3\r\n", b"1\r\n2\r\n2\r\n3\r\n", b"1\x1b[2;1H2\r\n3\r\n"]:
        assert not producer.validate_seq_stream(raw, 3)["exactSequence"]
