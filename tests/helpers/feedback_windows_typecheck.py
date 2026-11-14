"""Type-check Windows adapters with locked dependencies on a non-Windows host.

From the repository root on the configured Mac host:
    python3 -B tests/helpers/feedback_windows_typecheck.py
Or from Windows using the existing remote runner:
    macrun repo --repo <worktree> --subdir . --timeout 3000 -- python3 -B tests/helpers/feedback_windows_typecheck.py
This compiles metadata only; it never runs the application or accesses OS secrets.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

def main() -> int:
    root = Path.cwd()
    work = Path(tempfile.mkdtemp(prefix="feedback-windows-types-"))
    target = "x86_64-pc-windows-msvc"
    command = ["cargo", "check", "--manifest-path", "src-tauri/Cargo.toml", "--offline", "--locked",
        "--target", target, "-j", "2", "--message-format=json"]
    for package in ["tauri", "webview2-com", "windows@0.61", "tokio", "serde", "serde_json", "tempfile"]:
        command.extend(["-p", package])
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (work / "cargo-artifacts.jsonl").write_bytes(result.stdout)
    (work / "cargo-stderr.log").write_bytes(result.stderr)
    print(f"WINDOWS_DEPENDENCY_CHECK_EXIT {result.returncode}")
    if result.returncode:
        print(result.stderr.decode("utf-8")[-7000:])
        return result.returncode
    artifacts: dict[str, Path] = {}
    for line in result.stdout.splitlines():
        value = json.loads(line)
        if value.get("reason") != "compiler-artifact":
            continue
        name = value["target"]["name"]
        if name == "windows" and "windows@0.61" not in value["package_id"]:
            continue
        candidates = [Path(path) for path in value["filenames"] if path.endswith(".rmeta") and ("/" + target + "/") in Path(path).as_posix()]
        if candidates:
            artifacts[name] = candidates[0]
    imports = {"tauri":"tauri", "webview2_com":"webview2_com", "windows_webview2":"windows",
        "tokio":"tokio", "serde":"serde", "serde_json":"serde_json", "tempfile":"tempfile"}
    for name in imports.values():
        assert name in artifacts, name
    capture = root / "src-tauri/src/feedback/capture_windows.rs"
    store = root / "src-tauri/src/feedback/destination_store.rs"
    source = """
#![allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FeedbackError { Storage }
#[derive(serde::Deserialize, serde::Serialize)]
struct SecretDestination { token: String, destination: String }
trait SecretStore {
    fn exists(&self) -> Result<bool, FeedbackError>;
    fn read(&self) -> Result<Option<SecretDestination>, FeedbackError>;
    fn write(&self, value: &SecretDestination) -> Result<(), FeedbackError>;
    fn remove(&self) -> Result<(), FeedbackError>;
}
mod test_profile { pub fn name() -> Option<&'static str> { None } }
#[path = CAPTURE]
mod capture_windows;
#[path = STORE]
mod destination_store;
#[tauri::command]
async fn feedback_capture_typecheck(app: tauri::AppHandle, webview: tauri::Webview) -> Result<String, String> {
    capture_windows::capture(&app, webview.label()).await
}
""".replace("CAPTURE", json.dumps(str(capture))).replace("STORE", json.dumps(str(store)))
    wrapper = work / "adapters.rs"
    wrapper.write_text(source, encoding="utf-8")
    command = ["rustc", "--crate-name", "feedback_windows_typecheck", "--crate-type", "lib", "--edition=2021",
        "--target", target, "--emit=metadata", str(wrapper), "-o", str(work / "adapters.rmeta"),
        "-L", "dependency=" + str(root / "src-tauri/target" / target / "debug/deps"),
        "-L", "dependency=" + str(root / "src-tauri/target/debug/deps")]
    for alias, package in imports.items():
        command.extend(["--extern", alias + "=" + str(artifacts[package])])
    checked = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env={**os.environ, "CARGO_PKG_NAME": "mycmux", "CARGO_MANIFEST_DIR": str(root / "src-tauri")})
    (work / "rustc.log").write_bytes(checked.stdout)
    print(f"WINDOWS_SURFACE_TYPECHECK_EXIT {checked.returncode}")
    print(checked.stdout.decode("utf-8")[-7000:])
    for path in [capture, store]:
        print("CHECKED_SOURCE", path.relative_to(root), hashlib.sha256(path.read_bytes()).hexdigest())
    print("TYPECHECK_EVIDENCE", work)
    return checked.returncode

if __name__ == "__main__":
    raise SystemExit(main())
