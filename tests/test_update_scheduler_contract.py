"""The automatic update scheduler must only discover available updates."""

from pathlib import Path


def test_scheduler_never_installs_or_restarts_updates():
    scheduler = (
        Path(__file__).resolve().parents[1]
        / "src/lib/updateAvailabilityScheduler.ts"
    ).read_text(encoding="utf-8")
    for forbidden in ("installAvailableUpdate", "downloadAndInstall", "relaunch"):
        assert forbidden not in scheduler, f"Scheduler must not invoke {forbidden}"
