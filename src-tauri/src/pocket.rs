//! Finding the phone app ("ポケットmycmux") for the settings QR panel.
//!
//! mycmux used to ship its own mobile web UI behind a token URL (the old
//! `remote/` module, removed 2026-09-19). The phone app is a separate
//! service that talks to this PC over the socket API, so nothing here
//! serves or proxies it — the only job left is helping the phone *find*
//! it: look for a `tailscale serve` handler whose path is `/pocket` and
//! turn it into a QR code.
//!
//! The phone opens that URL in its browser. The iOS app carries an
//! Associated Domains entitlement for the same host but does not ship it
//! (a Personal signing team cannot), so scanning never hands off to the
//! app today — and will, with no change here, once that is signed.

use qrcode::QrCode;
use serde::Serialize;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

/// Per-call bound on the Tailscale CLI and on the reachability probe. The
/// panel can spend a few multiples of this in the worst case — each CLI
/// candidate path gets its own attempt, then the probe — so this caps a
/// single wedged call, not the whole refresh. Opening the settings tab
/// triggers it, and the panel shows a loading line while it runs.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Path prefix the phone app is served under (`tailscale serve --set-path=/pocket`).
const POCKET_PATH: &str = "/pocket";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PocketEntry {
    /// URL the phone should open. Empty when no `/pocket` handler exists.
    pub url: String,
    /// QR code for `url`. Empty when `url` is empty.
    pub qr_svg: String,
    /// Whether `url` answered with a usable status just now. False with a
    /// non-empty `url` means the route is published but nothing behind it
    /// answered — typically the app is not running.
    pub reachable: bool,
}

/// Resolve the phone entry, probing it so the panel can distinguish
/// "not published" from "published but not answering".
pub async fn resolve_entry() -> PocketEntry {
    let Some(url) = tailscale_serve_status_json()
        .await
        .as_deref()
        .and_then(pocket_url_from_serve)
    else {
        return PocketEntry {
            url: String::new(),
            qr_svg: String::new(),
            reachable: false,
        };
    };

    let reachable = probe_reachable(&url).await;
    PocketEntry {
        qr_svg: svg_qr(&url),
        url,
        reachable,
    }
}

/// Parse `tailscale serve status --json` and build the URL of the
/// `/pocket` handler. Returns `None` when no such handler is published.
pub fn pocket_url_from_serve(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let web = value.get("Web")?.as_object()?;

    for (listen, spec) in web {
        let Some(handlers) = spec.get("Handlers").and_then(|h| h.as_object()) else {
            continue;
        };
        if !handlers.keys().any(|path| is_pocket_path(path)) {
            continue;
        }
        // A listen key we cannot parse is no reason to stop looking: another
        // entry may still carry the route. (`?` here would end the search.)
        let Some((host, port)) = split_listen(listen) else {
            continue;
        };
        let scheme = scheme_for_port(&value, port);
        return Some(build_url(scheme, &host, port));
    }
    None
}

/// `/pocket` itself, or anything nested under it. `/pocketbook` is a
/// different route and must not match.
fn is_pocket_path(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');
    trimmed == POCKET_PATH || path.starts_with("/pocket/")
}

fn split_listen(listen: &str) -> Option<(String, u16)> {
    let trimmed = listen
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let (host, port_str) = trimmed.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port_str.parse().ok()?))
}

/// `tailscale serve status --json` records the scheme per TCP port; fall
/// back to the port convention when that section is missing.
fn scheme_for_port(value: &serde_json::Value, port: u16) -> &'static str {
    let declared = value
        .get("TCP")
        .and_then(|tcp| tcp.get(port.to_string()))
        .and_then(|entry| {
            if entry.get("HTTPS").and_then(serde_json::Value::as_bool) == Some(true) {
                Some("https")
            } else if entry.get("HTTP").and_then(serde_json::Value::as_bool) == Some(true) {
                Some("http")
            } else {
                None
            }
        });
    declared.unwrap_or(if port == 443 { "https" } else { "http" })
}

/// Always the app's root, even when only a nested route is published:
/// `/pocket/api` is not something to hand a phone. The default port stays
/// implicit to keep the QR short, and the trailing `/` lets the PWA resolve
/// its own assets.
fn build_url(scheme: &str, host: &str, port: u16) -> String {
    let authority = match (scheme, port) {
        ("https", 443) | ("http", 80) => host.to_string(),
        _ => format!("{host}:{port}"),
    };
    format!("{scheme}://{authority}{POCKET_PATH}/")
}

async fn probe_reachable(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(2))
        .build()
    else {
        return false;
    };
    match client.get(url).send().await {
        Ok(response) => answered_for_real(response.status()),
        Err(_) => false,
    }
}

/// `send()` resolves for *any* HTTP reply, so only the status separates "the
/// app answered" from the case this panel exists to report: `tailscale serve`
/// still publishes the route, but proxying to a dead backend returns 502.
fn answered_for_real(status: reqwest::StatusCode) -> bool {
    status.is_success() || status.is_redirection()
}

/// Render a QR code as a minimal SVG string.
pub fn svg_qr(url: &str) -> String {
    let code = match QrCode::new(url.as_bytes()) {
        Ok(c) => c,
        Err(_) => return String::from("<svg/>"),
    };

    let width = code.width();
    let data = code.to_colors();
    let margin = 4;
    let total = width + margin * 2;

    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" width=\"300\" height=\"300\">",
        total, total
    );
    svg.push_str(&format!(
        "<rect width=\"{}\" height=\"{}\" fill=\"#fff\"/>",
        total, total
    ));

    for row in 0..width {
        for col in 0..width {
            if data[row * width + col] == qrcode::Color::Dark {
                let x = col + margin;
                let y = row + margin;
                svg.push_str(&format!(
                    "<rect x=\"{}\" y=\"{}\" width=\"1\" height=\"1\" fill=\"#000\"/>",
                    x, y
                ));
            }
        }
    }

    svg.push_str("</svg>");
    svg
}

async fn tailscale_serve_status_json() -> Option<String> {
    run_tailscale(&["serve", "status", "--json"]).await
}

async fn run_tailscale(args: &[&str]) -> Option<String> {
    for path in existing_tailscale_paths(std::path::Path::exists) {
        if let Some(output) = run_tailscale_cmd(path, args).await {
            return Some(output);
        }
    }
    run_tailscale_cmd("tailscale", args).await
}

fn existing_tailscale_paths(exists: impl Fn(&std::path::Path) -> bool) -> Vec<&'static str> {
    tailscale_absolute_candidates()
        .iter()
        .copied()
        .filter(|path| exists(std::path::Path::new(path)))
        .collect()
}

#[cfg(target_os = "windows")]
fn tailscale_absolute_candidates() -> &'static [&'static str] {
    &[
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ]
}

#[cfg(target_os = "macos")]
fn tailscale_absolute_candidates() -> &'static [&'static str] {
    &[
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
    ]
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn tailscale_absolute_candidates() -> &'static [&'static str] {
    &[]
}

async fn run_tailscale_cmd(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = TokioCommand::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        // Without this the console subsystem flashes a window every time the
        // settings panel is opened.
        cmd.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }

    let output = match timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) | Err(_) => return None,
    };

    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command(async)]
pub async fn get_pocket_entry() -> Result<PocketEntry, String> {
    Ok(resolve_entry().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVE_WITH_POCKET: &str = r#"{
        "TCP": {
            "443": { "HTTPS": true }
        },
        "Web": {
            "miyazaki.tail3c3d6a.ts.net:443": {
                "Handlers": {
                    "/": { "Proxy": "http://127.0.0.1:8993" },
                    "/pocket": { "Proxy": "http://127.0.0.1:8994/pocket" }
                }
            }
        }
    }"#;

    const SERVE_WITHOUT_POCKET: &str = r#"{
        "TCP": { "443": { "HTTPS": true } },
        "Web": {
            "miyazaki.tail3c3d6a.ts.net:443": {
                "Handlers": { "/": { "Proxy": "http://127.0.0.1:8993" } }
            }
        }
    }"#;

    #[test]
    fn builds_https_url_without_the_default_port() {
        assert_eq!(
            pocket_url_from_serve(SERVE_WITH_POCKET).as_deref(),
            Some("https://miyazaki.tail3c3d6a.ts.net/pocket/")
        );
    }

    #[test]
    fn returns_none_when_no_pocket_handler_is_published() {
        assert_eq!(pocket_url_from_serve(SERVE_WITHOUT_POCKET), None);
    }

    #[test]
    fn returns_none_for_unparsable_status() {
        assert_eq!(pocket_url_from_serve("not json"), None);
        assert_eq!(pocket_url_from_serve("{}"), None);
    }

    #[test]
    fn keeps_a_non_default_port_in_the_url() {
        let json = r#"{
            "TCP": { "8443": { "HTTPS": true } },
            "Web": {
                "host.example.ts.net:8443": {
                    "Handlers": { "/pocket": { "Proxy": "http://127.0.0.1:8994/pocket" } }
                }
            }
        }"#;

        assert_eq!(
            pocket_url_from_serve(json).as_deref(),
            Some("https://host.example.ts.net:8443/pocket/")
        );
    }

    #[test]
    fn uses_the_scheme_declared_for_that_port() {
        let json = r#"{
            "TCP": { "7690": { "HTTP": true } },
            "Web": {
                "host.example.ts.net:7690": {
                    "Handlers": { "/pocket": { "Proxy": "http://127.0.0.1:8994/pocket" } }
                }
            }
        }"#;

        assert_eq!(
            pocket_url_from_serve(json).as_deref(),
            Some("http://host.example.ts.net:7690/pocket/")
        );
    }

    /// Publishing only a sub-route still means the app is there; the QR must
    /// carry its root, not `/pocket/api/`.
    #[test]
    fn a_nested_route_still_yields_the_app_root() {
        let json = r#"{
            "TCP": { "443": { "HTTPS": true } },
            "Web": {
                "host.example.ts.net:443": {
                    "Handlers": { "/pocket/api": { "Proxy": "http://127.0.0.1:8994/pocket/api" } }
                }
            }
        }"#;

        assert_eq!(
            pocket_url_from_serve(json).as_deref(),
            Some("https://host.example.ts.net/pocket/")
        );
    }

    /// A listen key we cannot read must not end the search: the route may be
    /// published on another one.
    #[test]
    fn an_unparsable_listen_key_does_not_hide_a_later_one() {
        let json = r#"{
            "TCP": { "443": { "HTTPS": true } },
            "Web": {
                "aaa-no-port": {
                    "Handlers": { "/pocket": { "Proxy": "http://127.0.0.1:8994/pocket" } }
                },
                "zzz.example.ts.net:443": {
                    "Handlers": { "/pocket": { "Proxy": "http://127.0.0.1:8994/pocket" } }
                }
            }
        }"#;

        assert_eq!(
            pocket_url_from_serve(json).as_deref(),
            Some("https://zzz.example.ts.net/pocket/")
        );
    }

    /// `send()` resolves for any reply, so a proxy with a dead backend (502)
    /// or a route that no longer exists (404) must not read as reachable.
    #[test]
    fn only_a_usable_status_counts_as_reachable() {
        for code in [200u16, 204, 301, 302] {
            let status = reqwest::StatusCode::from_u16(code).unwrap();
            assert!(answered_for_real(status), "{code} should count");
        }
        for code in [404u16, 500, 502, 503] {
            let status = reqwest::StatusCode::from_u16(code).unwrap();
            assert!(!answered_for_real(status), "{code} should not count");
        }
    }

    #[test]
    fn matches_a_nested_pocket_route_but_not_a_lookalike() {
        assert!(is_pocket_path("/pocket"));
        assert!(is_pocket_path("/pocket/"));
        assert!(is_pocket_path("/pocket/talk"));
        assert!(!is_pocket_path("/pocketbook"));
        assert!(!is_pocket_path("/"));
    }

    #[test]
    fn renders_a_qr_svg_for_the_entry_url() {
        let svg = svg_qr("https://miyazaki.tail3c3d6a.ts.net/pocket/");

        assert!(svg.starts_with("<svg xmlns="));
        assert!(svg.ends_with("</svg>"));
        assert!(svg.contains("<rect"));
    }
}
