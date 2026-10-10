# Fake CLI account acceptance fixtures

The Rust driver in `src-tauri/src/cli_accounts/fake_cli_tests.rs` runs these
Python 3.9+ scripts with the same argv and staging env key as `begin_cli_login`.
Only dummy credentials and `@example.test` identities are used. Each fixture
requires `MYCMUX_E2E_FAKE_CLI=1`, a UUID directory under `cli_login_staging`, and
its driver-owned `.fake-cli-test` marker. No script resolves a live CLI home.

On macOS, Claude writes only the scoped Keychain service hashed from the exact
temporary config-dir env string. The driver refuses pre-existing items, checks
identity before releasing credentials, captures through the native reader,
cleans the item and directory, and asserts ItemNotFound (exit 44). Other systems
use `.credentials.json`. Grok holds `auth.json.lock` before writing the auth file.
Handshake files make both delayed writes deterministic.

Codex records argv/store in `invocation.json`. Its limited config reader models
only the root string controlled by this driver; arbitrary product TOML parsing
has separate regression coverage. Non-file values write nothing and never use
a real keyring. The file override must supersede both keyring and auto configs.

Run outside the sandbox, from this checkout:

```sh
MYCMUX_E2E_FAKE_CLI=1 CARGO_TARGET_DIR=/Users/edu/Developer/_win-checks/target RUSTC=/Users/edu/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc /Users/edu/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo test --offline --manifest-path src-tauri/Cargo.toml --lib cli_accounts::fake_cli_tests:: -- --ignored --test-threads=1 --nocapture
```

Both `#[ignore]` and the env opt-in are required. Without the env variable,
explicitly running these tests fails before creating staging directories.
The six tests exercise subprocess → native watcher → capture/save → registry →
list → cleanup, including cancellation, timeout and storage-hole reproduction.
They use no Tauri window or browser; real OAuth and PTY/window behavior remain
the commander's post-update manual check.
