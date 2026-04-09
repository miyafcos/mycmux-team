use qrcode::QrCode;
use std::net::UdpSocket;

/// Detect the best IP address for remote access.
/// Priority: Tailscale IP (100.x.x.x) > LAN IP (192.168.x.x / 10.x.x.x).
/// Tailscale IPs work from anywhere; LAN IPs only on same network.
pub fn local_ip() -> Option<String> {
    // Check for Tailscale IP first (works from anywhere via VPN)
    if let Some(ts_ip) = tailscale_ip() {
        return Some(ts_ip);
    }
    // Fall back to LAN IP
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
}

/// Try to get the Tailscale IPv4 address via CLI.
fn tailscale_ip() -> Option<String> {
    // Windows: try common install paths
    let paths = [
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ];
    for path in &paths {
        if std::path::Path::new(path).exists() {
            if let Ok(output) = std::process::Command::new(path)
                .args(["ip", "-4"])
                .output()
            {
                if output.status.success() {
                    let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if ip.starts_with("100.") {
                        return Some(ip);
                    }
                }
            }
        }
    }
    // Unix / PATH fallback
    if let Ok(output) = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
    {
        if output.status.success() {
            let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if ip.starts_with("100.") {
                return Some(ip);
            }
        }
    }
    None
}

/// Build the connection URL.
pub fn connection_url(ip: &str, port: u16, token: &str) -> String {
    format!("http://{}:{}/#token={}", ip, port, token)
}

/// Render a QR code as ASCII art for terminal display.
pub fn ascii_qr(url: &str) -> String {
    let code = match QrCode::new(url.as_bytes()) {
        Ok(c) => c,
        Err(_) => return format!("(QR generation failed for: {url})"),
    };

    let width = code.width();
    let data = code.to_colors();
    let mut out = String::new();

    out.push_str(&"  ".repeat(width + 2));
    out.push('\n');

    for row in 0..width {
        out.push_str("  ");
        for col in 0..width {
            let dark = data[row * width + col] == qrcode::Color::Dark;
            out.push_str(if dark { "\u{2588}\u{2588}" } else { "  " });
        }
        out.push_str("  \n");
    }

    out
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
