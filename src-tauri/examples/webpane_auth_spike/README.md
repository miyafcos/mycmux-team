# Web pane authentication spike

This example opens one independent Tauri `WebviewWindow` at
`https://chatgpt.com` with an explicitly supplied WebView2 data directory.
It does not call `mycmux_lib::run()` or create the product's configured main
window.

Build:

```powershell
cargo build --manifest-path "C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\Cargo.toml" --example webpane_auth_spike
```

Run after the browser process that seeded the profile has fully exited:

```powershell
cargo run --manifest-path "C:\Users\miyaz\cmux-for-linux-dev-master\src-tauri\Cargo.toml" --example webpane_auth_spike -- --data-directory "C:\Users\miyaz\AppData\Local\mycmux-webpane-spike\a1-edge-seeded"
```

Do not point this example at the production mycmux WebView2 directory or a
normal Edge profile.
