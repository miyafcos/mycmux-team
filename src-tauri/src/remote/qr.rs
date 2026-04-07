use qrcode::QrCode;
use std::net::UdpSocket;

/// Detect the primary local IPv4 address by attempting a UDP "connect"
/// (no actual traffic is sent).
pub fn local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    Some(addr.ip().to_string())
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
