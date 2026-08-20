use qrcode::QrCode;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

/// Bound on how long we wait for Tailscale CLI and the reachability probe.
/// This runs on an async context (called from tokio-served handlers), so an
/// unresponsive CLI or hung HTTP GET must not stall a worker indefinitely.
const TAILSCALE_CMD_TIMEOUT: Duration = Duration::from_secs(2);

/// Public host:port that an iPhone can actually open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryHost {
    pub host: String,
    pub port: u16,
}

/// Choose a remote entry by the 便1b-1 priority:
/// 1. `tailscale serve` Web handler whose Proxy points at our loopback port
/// 2. if `bind_all`, Tailscale IP + our own port
/// 3. otherwise None (do not emit a QR)
///
/// This is the single selection function. Unit tests and
/// [`reachable_connection_url`] both call it — there is no test-only copy.
pub fn pick_entry(
    serve_json: Option<&str>,
    bind_all: bool,
    local_port: u16,
    tailscale_ip: Option<&str>,
) -> Option<EntryHost> {
    if let Some(json) = serve_json {
        if let Some(host) = public_host_from_serve(json, local_port) {
            return Some(host);
        }
    }
    if bind_all {
        if let Some(ip) = tailscale_ip.map(str::trim).filter(|ip| !ip.is_empty()) {
            return Some(EntryHost {
                host: ip.to_string(),
                port: local_port,
            });
        }
    }
    None
}

/// Resolve a connection URL the phone can reach. Candidates come from
/// [`pick_entry`]; each is HTTP-probed and a failed probe falls through to
/// the next rule (serve → bind_all → none).
pub async fn reachable_connection_url(
    local_port: u16,
    token: &str,
    bind_all: bool,
) -> Option<String> {
    let serve_json = tailscale_serve_status_json().await;
    let ts_ip = tailscale_ip().await;

    if let Some(host) = pick_entry(serve_json.as_deref(), false, local_port, None) {
        if probe_reachable(&host).await {
            return Some(connection_url(&host.host, host.port, token));
        }
    }
    if let Some(host) = pick_entry(None, bind_all, local_port, ts_ip.as_deref()) {
        if probe_reachable(&host).await {
            return Some(connection_url(&host.host, host.port, token));
        }
    }
    None
}

/// Parse `tailscale serve status --json` and return the public host:port
/// whose handler proxies to `http://127.0.0.1:{local_port}` (or localhost).
fn public_host_from_serve(json: &str, local_port: u16) -> Option<EntryHost> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let web = value.get("Web")?.as_object()?;
    for (listen, spec) in web {
        let Some(handlers) = spec.get("Handlers").and_then(|h| h.as_object()) else {
            continue;
        };
        let matches_us = handlers.values().any(|handler| {
            handler
                .get("Proxy")
                .and_then(|p| p.as_str())
                .is_some_and(|proxy| proxy_targets_port(proxy, local_port))
        });
        if matches_us {
            if let Some(host) = parse_listen_host(listen) {
                return Some(host);
            }
        }
    }
    None
}

fn proxy_targets_port(proxy: &str, local_port: u16) -> bool {
    let trimmed = proxy.trim().trim_end_matches('/');
    let candidates = [
        format!("http://127.0.0.1:{local_port}"),
        format!("http://localhost:{local_port}"),
        format!("http://[::1]:{local_port}"),
    ];
    candidates
        .iter()
        .any(|candidate| trimmed.eq_ignore_ascii_case(candidate))
}

fn parse_listen_host(listen: &str) -> Option<EntryHost> {
    let trimmed = listen
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let (host, port_str) = trimmed.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    let port: u16 = port_str.parse().ok()?;
    Some(EntryHost {
        host: host.to_string(),
        port,
    })
}

async fn probe_reachable(host: &EntryHost) -> bool {
    let origin = format!("http://{}:{}/", host.host, host.port);
    let client = match reqwest::Client::builder()
        .timeout(TAILSCALE_CMD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(2))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client.get(origin).send().await.is_ok()
}

async fn tailscale_ip() -> Option<String> {
    let ip = run_tailscale(&["ip", "-4"]).await?;
    let ip = ip.trim().to_string();
    if ip.starts_with("100.") {
        Some(ip)
    } else {
        None
    }
}

async fn tailscale_serve_status_json() -> Option<String> {
    run_tailscale(&["serve", "status", "--json"]).await
}

async fn run_tailscale(args: &[&str]) -> Option<String> {
    let paths = [
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ];
    for path in &paths {
        if std::path::Path::new(path).exists() {
            if let Some(output) = run_tailscale_cmd(path, args).await {
                return Some(output);
            }
        }
    }
    run_tailscale_cmd("tailscale", args).await
}

async fn run_tailscale_cmd(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = TokioCommand::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        // Without this the console subsystem flashes a window on every probe,
        // and this runs whenever the remote QR panel is opened.
        cmd.creation_flags(crate::util::process::CREATE_NO_WINDOW);
    }

    let output = match timeout(TAILSCALE_CMD_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) | Err(_) => return None,
    };

    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Build the connection URL.
pub fn connection_url(ip: &str, port: u16, token: &str) -> String {
    format!("http://{}:{}/?token={}", ip, port, token)
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

#[cfg(test)]
mod tests {
    use super::*;

    const SERVE_MATCHING: &str = r#"{
        "Web": {
            "host.example.ts.net:7683": {
                "Handlers": { "/": { "Proxy": "http://127.0.0.1:7682" } }
            }
        }
    }"#;

    const SERVE_OTHER_PORT: &str = r#"{
        "Web": {
            "host.example.ts.net:7683": {
                "Handlers": { "/": { "Proxy": "http://127.0.0.1:3001" } }
            }
        }
    }"#;

    const SERVE_TWO_HANDLERS: &str = r#"{
        "TCP": {
            "7683": { "HTTP": true },
            "7684": { "HTTP": true }
        },
        "Web": {
            "host.example.ts.net:7683": {
                "Handlers": { "/": { "Proxy": "http://127.0.0.1:7682" } }
            },
            "host.example.ts.net:7684": {
                "Handlers": { "/": { "Proxy": "http://127.0.0.1:3001" } }
            }
        }
    }"#;

    #[test]
    fn serve_json_matching_proxy_selects_public_host() {
        let entry = pick_entry(Some(SERVE_MATCHING), false, 7682, Some("100.103.126.82"))
            .expect("matching serve proxy should be selected");
        assert_eq!(entry.host, "host.example.ts.net");
        assert_eq!(entry.port, 7683);
        assert_eq!(
            connection_url(&entry.host, entry.port, "tok"),
            "http://host.example.ts.net:7683/?token=tok"
        );
    }

    #[test]
    fn serve_json_other_port_is_not_selected() {
        assert_eq!(
            pick_entry(Some(SERVE_OTHER_PORT), false, 7682, Some("100.103.126.82")),
            None
        );
    }

    #[test]
    fn no_serve_bind_all_selects_tailscale_ip() {
        assert_eq!(
            pick_entry(None, true, 7682, Some("100.103.126.82")),
            Some(EntryHost {
                host: "100.103.126.82".into(),
                port: 7682,
            })
        );
    }

    #[test]
    fn no_serve_loopback_only_returns_none() {
        assert_eq!(pick_entry(None, false, 7682, Some("100.103.126.82")), None);
    }

    #[test]
    fn serve_matching_proxy_wins_over_bind_all() {
        let entry = pick_entry(Some(SERVE_MATCHING), true, 7682, Some("100.103.126.82"))
            .expect("serve must beat bind_all");
        assert_eq!(entry.host, "host.example.ts.net");
        assert_eq!(entry.port, 7683);
    }

    #[test]
    fn two_handlers_selects_only_our_port() {
        let entry = pick_entry(Some(SERVE_TWO_HANDLERS), false, 7682, None)
            .expect("7682 proxy should win over 3001");
        assert_eq!(entry.host, "host.example.ts.net");
        assert_eq!(entry.port, 7683);
    }
}
