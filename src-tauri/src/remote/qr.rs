use qrcode::QrCode;
use std::net::UdpSocket;
use std::time::Duration;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

/// Bound on how long we wait for `tailscale ip -4` to answer. This runs on an
/// async context (called from tokio-served handlers), so an unresponsive or
/// hung Tailscale CLI must not be able to stall a worker indefinitely.
const TAILSCALE_CMD_TIMEOUT: Duration = Duration::from_secs(2);

/// Detect the best IP address for remote access.
/// Priority: Tailscale IP (100.x.x.x) > LAN IP (192.168.x.x / 10.x.x.x).
/// Tailscale IPs work from anywhere; LAN IPs only on same network.
pub async fn local_ip() -> Option<String> {
    // Check for Tailscale IP first (works from anywhere via VPN)
    if let Some(ts_ip) = tailscale_ip().await {
        return Some(ts_ip);
    }
    // Fall back to LAN IP
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

/// Try to get the Tailscale IPv4 address via CLI.
async fn tailscale_ip() -> Option<String> {
    // Windows: try common install paths
    let paths = [
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ];
    for path in &paths {
        if std::path::Path::new(path).exists() {
            if let Some(ip) = run_tailscale_ip(path).await {
                return Some(ip);
            }
        }
    }
    // Unix / PATH fallback
    run_tailscale_ip("tailscale").await
}

/// Run `<program> ip -4`, bounded by `TAILSCALE_CMD_TIMEOUT`. Returns `None`
/// on spawn failure, non-zero exit, timeout, or a non-Tailscale address.
async fn run_tailscale_ip(program: &str) -> Option<String> {
    let mut cmd = TokioCommand::new(program);
    cmd.args(["ip", "-4"]);
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
    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if ip.starts_with("100.") {
        Some(ip)
    } else {
        None
    }
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
