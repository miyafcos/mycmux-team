"""Contract tests for the Tauri updater feed (normalization + signature key-id).

Three invariants that used to live only in a human's memory are pinned here.

1. Normalization (0.9.x dual-install split-brain): the plain "windows-x86_64"
   platform key in latest.json must always carry the same signature/url as the
   "windows-x86_64-nsis" entry. scripts/normalize_updater_feed.py is the shared,
   cross-platform implementation; the existing PowerShell entry remains compatible.
2. Signing key-id (v0.21.16, 2026-08-05): CI shipped a release signed with a
   rotated-away key because GitHub Secrets still held the old one. The feed
   advertised the right *version*, so every version-only check passed, and the
   in-app update button failed for users with a signature verification error.
   scripts/verify_updater_feed.py compares the minisign key-id of every
   platforms[] signature against the key-id of plugins.updater.pubkey.
3. Platform coverage: a release feed must contain the existing Windows keys and
   the Apple Silicon updater key, "darwin-aarch64".

No network access is used -- everything is local.
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
NORMALIZE_SCRIPT = REPO_ROOT / "scripts" / "normalize-updater-feed.ps1"
NORMALIZE_PYTHON_SCRIPT = REPO_ROOT / "scripts" / "normalize_updater_feed.py"
VERIFY_SCRIPT = REPO_ROOT / "scripts" / "verify_updater_feed.py"
RELEASE_LOCAL_SCRIPT = REPO_ROOT / "scripts" / "release-local.ps1"
RELEASE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"
TAURI_CONFIG = REPO_ROOT / "src-tauri" / "tauri.conf.json"
BUILD_MAC_SCRIPT = REPO_ROOT / "scripts" / "build-mac.sh"
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "latest_raw_prenormalize.json"

sys.path.insert(0, str(REPO_ROOT / "scripts"))

import verify_updater_feed  # noqa: E402
import mirror_personal_updater_feed  # noqa: E402
import normalize_updater_feed  # noqa: E402


def run_direct_contracts() -> None:
    """Run critical cross-platform contracts when pytest is unavailable."""
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    darwin_entry = {
        "signature": "darwin-signature",
        "url": "https://example.invalid/mycmux.app.tar.gz",
    }
    raw["platforms"]["darwin-aarch64"] = darwin_entry
    normalized = normalize_updater_feed.normalize_feed(raw)
    assert normalized["platforms"]["windows-x86_64"] == normalized["platforms"][
        "windows-x86_64-nsis"
    ]
    assert normalized["platforms"]["darwin-aarch64"] == darwin_entry

    names = [
        "mycmux_9.9.9_x64-setup.exe",
        "mycmux_9.9.9_x64-setup.exe.sig",
        "mycmux_9.9.9_x64_en-US.msi",
        "mycmux_9.9.9_x64_en-US.msi.sig",
        "mycmux_9.9.9_aarch64.dmg",
        "mycmux.app.tar.gz",
        "mycmux.app.tar.gz.sig",
    ]
    selected = mirror_personal_updater_feed.select_asset_names(names)
    signatures = {
        "windows_nsis_sig": "nsis-signature",
        "windows_msi_sig": "msi-signature",
        "macos_updater_sig": "darwin-signature",
    }
    feed = mirror_personal_updater_feed.build_feed(
        version="9.9.9",
        source_tag="v9.9.9",
        target_repo="example/public",
        target_tag="updater",
        published_at="2026-09-05T00:00:00Z",
        selected=selected,
        signatures=signatures,
    )
    assert set(feed["platforms"]) == verify_updater_feed.REQUIRED_PLATFORMS
    assert feed["platforms"]["darwin-aarch64"]["url"].endswith("mycmux.app.tar.gz")

    config = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
    assert config["bundle"]["macOS"]["signingIdentity"] is None
    assert "APPLE_SIGNING_IDENTITY" in BUILD_MAC_SCRIPT.read_text(encoding="utf-8")

    workflow = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    for required in (
        "runs-on: macos-14",
        "cargo test --lib",
        "npx tsc --noEmit",
        "npx vitest run",
        "--target aarch64-apple-darwin",
        "--bundles app,dmg",
        "--no-sign",
        "mirror_personal_updater_feed.py",
    ):
        assert required in workflow


try:
    import pytest
except ModuleNotFoundError:
    if __name__ == "__main__":
        run_direct_contracts()
        print("PASS direct updater feed contracts (pytest unavailable)")
        raise SystemExit(0)
    raise

# Only the compatibility-wrapper test needs Windows; normalization and feed
# generation are pure Python and must run on macOS CI too.
requires_powershell = pytest.mark.skipif(
    sys.platform != "win32", reason="normalize-updater-feed.ps1 requires Windows PowerShell"
)


def run_normalize(input_path: Path, output_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(NORMALIZE_PYTHON_SCRIPT),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"normalize_updater_feed.py failed (exit {result.returncode}):\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )


def test_fixture_reflects_the_real_bug_shape_before_normalization() -> None:
    """Sanity check that the fixture is not already normalized: otherwise the
    contract test below would pass vacuously."""
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    plain = raw["platforms"]["windows-x86_64"]
    nsis = raw["platforms"]["windows-x86_64-nsis"]
    assert plain != nsis, (
        "fixture must start in the pre-normalization (buggy) shape, where the "
        "plain windows-x86_64 key does not yet match windows-x86_64-nsis"
    )


def test_normalize_updater_feed_makes_plain_key_match_nsis_entry(tmp_path: Path) -> None:
    output_path = tmp_path / "latest.normalized.json"
    run_normalize(FIXTURE, output_path)

    normalized = json.loads(output_path.read_text(encoding="utf-8"))
    platforms = normalized["platforms"]

    assert platforms["windows-x86_64"]["signature"] == platforms["windows-x86_64-nsis"]["signature"]
    assert platforms["windows-x86_64"]["url"] == platforms["windows-x86_64-nsis"]["url"]

    # The normalization must not silently repoint the fallback key at the MSI.
    assert platforms["windows-x86_64"]["url"] != platforms["windows-x86_64-msi"]["url"]


def test_normalize_updater_feed_leaves_other_platform_entries_untouched(tmp_path: Path) -> None:
    output_path = tmp_path / "latest.normalized.json"
    run_normalize(FIXTURE, output_path)

    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    normalized = json.loads(output_path.read_text(encoding="utf-8"))

    assert normalized["version"] == raw["version"]
    assert normalized["platforms"]["windows-x86_64-nsis"] == raw["platforms"]["windows-x86_64-nsis"]
    assert normalized["platforms"]["windows-x86_64-msi"] == raw["platforms"]["windows-x86_64-msi"]


def test_normalize_updater_feed_fails_closed_without_nsis_entry(tmp_path: Path) -> None:
    broken = tmp_path / "latest.no-nsis.json"
    broken.write_text(
        json.dumps(
            {
                "version": "0.9.5",
                "platforms": {
                    "windows-x86_64-msi": {"signature": "sig", "url": "https://example.invalid/x.msi"}
                },
            }
        ),
        encoding="utf-8",
    )
    output_path = tmp_path / "latest.normalized.json"

    result = subprocess.run(
        [
            sys.executable,
            str(NORMALIZE_PYTHON_SCRIPT),
            "--input",
            str(broken),
            "--output",
            str(output_path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, "normalize script must fail closed when the nsis entry is missing"
    assert "windows-x86_64-nsis" in result.stderr


def test_normalize_updater_feed_preserves_darwin_entry() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    darwin = {
        "signature": "darwin-signature",
        "url": "https://example.invalid/mycmux.app.tar.gz",
    }
    raw["platforms"]["darwin-aarch64"] = darwin

    normalized = normalize_updater_feed.normalize_feed(raw)

    assert normalized["platforms"]["darwin-aarch64"] == darwin


@requires_powershell
def test_powershell_normalizer_entry_remains_compatible(tmp_path: Path) -> None:
    output_path = tmp_path / "latest.normalized.json"
    result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(NORMALIZE_SCRIPT),
            "-InputPath",
            str(FIXTURE),
            "-OutputPath",
            str(output_path),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


# ---------------------------------------------------------------------------
# Signature key-id verification (scripts/verify_updater_feed.py)
# ---------------------------------------------------------------------------

CURRENT_KEY_ID = "bbf2382d7a0753cc"
ROTATED_AWAY_KEY_ID = "edfd48df84ad2477"  # the stale secret behind the v0.21.16 incident


def make_pubkey_blob(key_id_hex: str) -> str:
    """Build a synthetic minisign *public key* blob (2-line minisign file)."""
    raw = b"Ed" + bytes.fromhex(key_id_hex) + b"\x11" * 32
    text = (
        f"untrusted comment: minisign public key: {key_id_hex.upper()}\n"
        f"{base64.b64encode(raw).decode('ascii')}\n"
    )
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def make_signature_blob(key_id_hex: str, file_name: str = "mycmux_9.9.9_x64-setup.exe") -> str:
    """Build a synthetic minisign *signature* blob (4-line minisign file).

    The 4-line shape matters: line 2 is the signature (whose key-id we want) and
    line 4 is the global signature, which carries no key-id. A parser that grabs
    the wrong line would silently compare garbage.
    """
    raw = b"ED" + bytes.fromhex(key_id_hex) + b"\x22" * 64
    global_sig = base64.b64encode(b"\x33" * 64).decode("ascii")
    text = (
        "untrusted comment: signature from tauri secret key\n"
        f"{base64.b64encode(raw).decode('ascii')}\n"
        f"trusted comment: timestamp:1786205910\tfile:{file_name}\n"
        f"{global_sig}\n"
    )
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def make_feed(version: str, key_ids: dict[str, str]) -> dict:
    return {
        "version": version,
        "notes": "synthetic",
        "pub_date": "2026-08-09T00:00:00.000Z",
        "platforms": {
            name: {
                "signature": make_signature_blob(key_id),
                "url": f"https://example.invalid/{name}",
            }
            for name, key_id in key_ids.items()
        },
    }


def all_supported_keys(key_id: str) -> dict[str, str]:
    return {
        "windows-x86_64": key_id,
        "windows-x86_64-msi": key_id,
        "windows-x86_64-nsis": key_id,
        "darwin-aarch64": key_id,
    }


def test_extract_key_id_reads_the_same_bytes_from_pubkey_and_signature_blobs() -> None:
    """Both sides of the comparison must go through one function, so that the
    byte order of the key-id can never diverge between them."""
    assert verify_updater_feed.extract_key_id(make_pubkey_blob(CURRENT_KEY_ID)) == CURRENT_KEY_ID
    assert verify_updater_feed.extract_key_id(make_signature_blob(CURRENT_KEY_ID)) == CURRENT_KEY_ID


def test_extract_key_id_ignores_the_trusted_comment_and_global_signature_lines() -> None:
    other = verify_updater_feed.extract_key_id(make_signature_blob(ROTATED_AWAY_KEY_ID))
    assert other == ROTATED_AWAY_KEY_ID
    assert other != CURRENT_KEY_ID


@pytest.mark.parametrize(
    "blob, reason",
    [
        ("", "empty"),
        ("   ", "blank"),
        ("not base64 at all !!!", "not base64"),
        (
            base64.b64encode(b"untrusted comment: only a comment\n").decode("ascii"),
            "no payload line",
        ),
        (
            base64.b64encode(
                b"untrusted comment: x\n" + base64.b64encode(b"short") + b"\n"
            ).decode("ascii"),
            "payload too short for a key-id",
        ),
    ],
)
def test_extract_key_id_fails_closed_on_malformed_blobs(blob: str, reason: str) -> None:
    with pytest.raises(verify_updater_feed.VerificationError):
        verify_updater_feed.extract_key_id(blob)


def test_shipped_pubkey_parses_to_a_key_id() -> None:
    config = verify_updater_feed.load_config()
    key_id = verify_updater_feed.config_pubkey_key_id(config)
    assert len(key_id) == 16
    int(key_id, 16)  # raises if the parse produced anything but hex


def test_verify_feed_passes_when_every_platform_uses_the_expected_key() -> None:
    feed = make_feed("9.9.9", all_supported_keys(CURRENT_KEY_ID))
    assert verify_updater_feed.verify_feed(feed, "9.9.9", CURRENT_KEY_ID) is True


def test_verify_feed_fails_when_signed_with_a_rotated_away_key() -> None:
    """The v0.21.16 shape: correct version, wrong signing key."""
    feed = make_feed("9.9.9", all_supported_keys(ROTATED_AWAY_KEY_ID))
    assert verify_updater_feed.verify_feed(feed, "9.9.9", CURRENT_KEY_ID) is False


def test_verify_feed_fails_when_only_one_platform_entry_is_mis_signed() -> None:
    key_ids = all_supported_keys(CURRENT_KEY_ID)
    key_ids["windows-x86_64-msi"] = ROTATED_AWAY_KEY_ID
    feed = make_feed("9.9.9", key_ids)
    assert verify_updater_feed.verify_feed(feed, "9.9.9", CURRENT_KEY_ID) is False


def test_verify_feed_fails_on_a_stale_feed_version() -> None:
    """The mirror silent-skip shape: the feed never advanced to the new release."""
    feed = make_feed("9.9.8", all_supported_keys(CURRENT_KEY_ID))
    assert verify_updater_feed.verify_feed(feed, "9.9.9", CURRENT_KEY_ID) is False


def test_verify_feed_fails_when_the_feed_has_no_platform_entries() -> None:
    assert verify_updater_feed.verify_feed({"version": "9.9.9", "platforms": {}}, "9.9.9", CURRENT_KEY_ID) is False


def test_verify_feed_fails_when_darwin_aarch64_is_missing() -> None:
    keys = all_supported_keys(CURRENT_KEY_ID)
    del keys["darwin-aarch64"]
    assert verify_updater_feed.verify_feed(make_feed("9.9.9", keys), "9.9.9", CURRENT_KEY_ID) is False


def run_verify_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(VERIFY_SCRIPT)] + args,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def write_feed(tmp_path: Path, feed: dict) -> Path:
    path = tmp_path / "latest.json"
    path.write_text(json.dumps(feed), encoding="utf-8")
    return path


def test_verify_cli_offline_exits_zero_on_a_good_feed(tmp_path: Path) -> None:
    config_key_id = verify_updater_feed.config_pubkey_key_id(verify_updater_feed.load_config())
    feed_path = write_feed(tmp_path, make_feed("9.9.9", all_supported_keys(config_key_id)))

    result = run_verify_cli(["--expect-version", "9.9.9", "--file", str(feed_path)])
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS updater feed verification" in result.stdout


def test_verify_cli_offline_exits_nonzero_on_a_mis_signed_feed(tmp_path: Path) -> None:
    feed_path = write_feed(tmp_path, make_feed("9.9.9", all_supported_keys(ROTATED_AWAY_KEY_ID)))

    result = run_verify_cli(["--expect-version", "9.9.9", "--file", str(feed_path)])
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FAIL" in result.stdout


def test_verify_cli_requires_an_expected_version() -> None:
    result = run_verify_cli([])
    assert result.returncode != 0
    assert "--expect-version" in result.stderr


# ---------------------------------------------------------------------------
# Combined release feed (scripts/mirror_personal_updater_feed.py)
# ---------------------------------------------------------------------------


def test_mirror_asset_selection_requires_windows_and_universal_macos_bundles() -> None:
    names = [
        "mycmux_9.9.9_x64-setup.exe",
        "mycmux_9.9.9_x64-setup.exe.sig",
        "mycmux_9.9.9_x64_en-US.msi",
        "mycmux_9.9.9_x64_en-US.msi.sig",
        "mycmux_9.9.9_universal.dmg",
        "mycmux.app.tar.gz",
        "mycmux.app.tar.gz.sig",
    ]

    selected = mirror_personal_updater_feed.select_asset_names(names)

    assert set(selected) == set(mirror_personal_updater_feed.ASSET_PATTERNS)


def test_mirror_asset_selection_rejects_an_apple_silicon_only_dmg() -> None:
    # The macOS bundle went universal so Intel Macs get a build at all. An
    # arm64-only .dmg carries no x86_64 slice, so shipping one leaves the
    # darwin-x86_64 feed entry pointing at something those machines cannot run.
    names = [
        "mycmux_9.9.9_x64-setup.exe",
        "mycmux_9.9.9_x64-setup.exe.sig",
        "mycmux_9.9.9_x64_en-US.msi",
        "mycmux_9.9.9_x64_en-US.msi.sig",
        "mycmux_9.9.9_aarch64.dmg",
        "mycmux.app.tar.gz",
        "mycmux.app.tar.gz.sig",
    ]

    with pytest.raises(mirror_personal_updater_feed.MirrorError) as excinfo:
        mirror_personal_updater_feed.select_asset_names(names)

    assert "macos_dmg" in str(excinfo.value)


def test_combined_feed_contains_darwin_aarch64_and_preserves_windows_fallback() -> None:
    selected = {
        "windows_nsis": "mycmux_9.9.9_x64-setup.exe",
        "windows_nsis_sig": "mycmux_9.9.9_x64-setup.exe.sig",
        "windows_msi": "mycmux_9.9.9_x64_en-US.msi",
        "windows_msi_sig": "mycmux_9.9.9_x64_en-US.msi.sig",
        "macos_dmg": "mycmux_9.9.9_universal.dmg",
        "macos_updater": "mycmux.app.tar.gz",
        "macos_updater_sig": "mycmux.app.tar.gz.sig",
    }
    signatures = {
        "windows_nsis_sig": "nsis-signature",
        "windows_msi_sig": "msi-signature",
        "macos_updater_sig": "darwin-signature",
    }

    feed = mirror_personal_updater_feed.build_feed(
        version="9.9.9",
        source_tag="v9.9.9",
        target_repo="example/public",
        target_tag="updater",
        published_at="2026-09-05T00:00:00Z",
        selected=selected,
        signatures=signatures,
    )

    platforms = feed["platforms"]
    assert platforms["darwin-aarch64"] == {
        "signature": "darwin-signature",
        "url": "https://github.com/example/public/releases/download/updater/mycmux.app.tar.gz",
    }
    assert platforms["windows-x86_64"] == platforms["windows-x86_64-nsis"]
    assert platforms["windows-x86_64"] != platforms["windows-x86_64-msi"]


# ---------------------------------------------------------------------------
# Release-path contracts: the checker has to actually be wired in
# ---------------------------------------------------------------------------


def test_release_local_runs_the_feed_verification() -> None:
    text = RELEASE_LOCAL_SCRIPT.read_text(encoding="utf-8")
    assert "verify_updater_feed.py" in text, (
        "scripts/release-local.ps1 must run scripts/verify_updater_feed.py; without it a "
        "release signed with the wrong key ships green again (v0.21.16)"
    )
    assert "--expect-version" in text
    # Invoke-NativeVisible throws on a non-zero exit, which is what fails the release.
    assert "Invoke-NativeVisible -FilePath \"python\" -Arguments @($verifyScript" in text


def test_release_workflow_fails_loudly_when_the_mirror_is_skipped() -> None:
    text = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    assert "id: mirror" in text, "the mirror step needs an id so its outcome can be asserted"
    assert "steps.mirror.outcome" in text, (
        "the mirror step is continue-on-error, so a later step must assert its outcome; "
        "otherwise a missing MYCMUX_TEAM_RELEASE_TOKEN leaves the release green while the "
        "public updater feed never advances"
    )
    assert "verify_updater_feed.py" in text, (
        "CI must verify the published feed's version and signing key-id"
    )


def test_release_workflow_builds_and_tests_apple_silicon_macos() -> None:
    text = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    for required in (
        "runs-on: macos-14",
        "cargo test --lib",
        "npx tsc --noEmit",
        "npx vitest run",
        "--target aarch64-apple-darwin",
        "--bundles app,dmg",
        "--no-sign",
        "*.app.tar.gz",
        "mirror_personal_updater_feed.py",
    ):
        assert required in text


def test_macos_signing_identity_is_null_with_environment_override_path() -> None:
    config = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
    assert config["bundle"]["macOS"]["signingIdentity"] is None

    build_script = BUILD_MAC_SCRIPT.read_text(encoding="utf-8")
    assert "APPLE_SIGNING_IDENTITY" in build_script
    assert "--no-sign" in build_script
