pub mod auth;
pub mod qr;
pub mod session;
pub mod ws_handler;

use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use session::RemoteSessionManager;
use std::sync::Arc;
use tauri::Emitter;

/// Shared state for the remote server.
pub struct RemoteState {
    pub token: String,
    pub sessions: RemoteSessionManager,
    pub app_session_manager: Arc<crate::pty::manager::SessionManager>,
    pub metadata_store: crate::pty::monitor::MetadataStore,
    pub app_handle: tauri::AppHandle,
}

// Embedded client files
#[derive(rust_embed::RustEmbed)]
#[folder = "src/remote/client/"]
struct ClientAssets;

/// Start the remote WebSocket server on a background tokio task.
pub fn start_remote_server(
    app: tauri::AppHandle,
    session_manager: Arc<crate::pty::manager::SessionManager>,
    metadata_store: crate::pty::monitor::MetadataStore,
) {
    tauri::async_runtime::spawn(async move {
        let token = auth::load_or_create_token();
        let port: u16 = std::env::var("MYCMUX_REMOTE_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(7681);

        let state = Arc::new(RemoteState {
            token: token.clone(),
            sessions: RemoteSessionManager::new(),
            app_session_manager: session_manager,
            metadata_store,
            app_handle: app,
        });

        let app = Router::new()
            .route("/ws", get(ws_handler::ws_upgrade))
            .route("/qr", get(serve_qr))
            .route("/api/state", get(api_state))
            .fallback(get(serve_static))
            .with_state(state.clone());

        // Write port file for discovery
        let port_file = match dirs::home_dir() {
            Some(mut p) => {
                p.push(".mycmux-lite");
                std::fs::create_dir_all(&p).ok();
                p.push("remote.port");
                let _ = std::fs::write(&p, port.to_string());
                Some(p)
            }
            None => {
                eprintln!("[remote] Could not determine home directory for port file");
                None
            }
        };

        // Print connection info + QR (prefer Tailscale IP for anywhere access)
        if let Some(ip) = qr::local_ip() {
            let url = qr::connection_url(&ip, port, &token);
            let via = if ip.starts_with("100.") { "Tailscale" } else { "LAN" };
            println!("\n=== mycmux Remote Terminal ({via}) ===");
            println!("URL: {url}");
            println!();
            println!("{}", qr::ascii_qr(&url));
            println!("Scan this QR code with your iPhone camera.");
            println!("==============================\n");
        } else {
            println!("[remote] Could not detect local IP. Access via http://localhost:{port}");
        }

        let addr = format!("0.0.0.0:{port}");
        println!("[remote] Listening on {addr}");

        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[remote] Failed to bind {addr}: {e}");
                if let Some(ref pf) = port_file { let _ = std::fs::remove_file(pf); }
                let _ = state.app_handle.emit("remote-error", format!("Remote terminal failed: port {port} in use"));
                return;
            }
        };

        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[remote] Server error: {e}");
        }
    });
}

/// Extract workspace ID from session ID: "pty-{wsId}-{paneId}-{tabId}"
fn extract_workspace_id(session_id: &str) -> Option<&str> {
    let rest = session_id.strip_prefix("pty-")?;
    // UUID format: 8-4-4-4-12 = 36 chars
    if rest.len() >= 36 { Some(&rest[..36]) } else { None }
}

fn basename(path: &str) -> Option<&str> {
    path.rsplit(['\\', '/']).find(|segment| !segment.is_empty())
}

fn normalize_process_name(process_name: Option<&str>) -> Option<String> {
    let raw = process_name?;
    let leaf = raw.rsplit(['\\', '/']).next().unwrap_or(raw).trim();
    if leaf.is_empty() {
        return None;
    }

    Some(leaf.strip_suffix(".exe").unwrap_or(leaf).to_string())
}

fn is_shell_process_name(process_name: &str) -> bool {
    matches!(
        process_name.to_ascii_lowercase().as_str(),
        "bash" | "sh" | "zsh" | "fish" | "pwsh" | "powershell" | "cmd" | "nu" | "nushell"
    )
}

fn is_generic_workspace_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return true;
    }

    trimmed
        .strip_prefix("Workspace ")
        .map(|suffix| !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit()))
        .unwrap_or(false)
}

fn is_home_dir(path: &str) -> bool {
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_lowercase();
    // Match common home directory patterns
    normalized.starts_with("/c/users/") && normalized.matches('/').count() == 3
        || normalized.starts_with("c:/users/") && normalized.matches('/').count() == 2
}

fn build_pane_label(
    _session_id: &str,
    cwd: Option<&str>,
    git_branch: Option<&str>,
    process_name: Option<&str>,
) -> String {
    // Prefer git branch as the most distinctive identifier
    if let Some(branch) = git_branch.filter(|branch| !branch.trim().is_empty()) {
        return branch.to_string();
    }

    // Use non-shell process name (e.g. "claude", "vim", "node")
    if let Some(process) = process_name.filter(|process| !is_shell_process_name(process)) {
        return process.to_string();
    }

    // Use cwd basename, but skip if it's just the home directory
    if let Some(path) = cwd.filter(|p| !is_home_dir(p)) {
        if let Some(name) = basename(path) {
            return name.to_string();
        }
    }

    "Terminal".to_string()
}

fn build_workspace_name(stored_name: Option<&str>, pane_labels: &[String], index: usize) -> String {
    if let Some(name) = stored_name.filter(|name| !is_generic_workspace_name(name)) {
        return name.to_string();
    }

    // Use the most distinctive pane label as workspace name
    if let Some(label) = pane_labels
        .iter()
        .find(|label| !label.trim().is_empty() && label.as_str() != "Terminal")
    {
        return label.clone();
    }

    format!("Workspace {}", index + 1)
}

/// Add numbers to duplicate labels: ["Terminal", "Terminal", "node"] → ["Terminal 1", "Terminal 2", "node"]
fn deduplicate_labels(labels: &mut [String]) {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for label in labels.iter() {
        *counts.entry(label.clone()).or_default() += 1;
    }
    // Only number labels that appear more than once
    let mut indices: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for label in labels.iter_mut() {
        if counts.get(label.as_str()).copied().unwrap_or(0) > 1 {
            let idx = indices.entry(label.clone()).or_insert(0);
            *idx += 1;
            *label = format!("{} {}", label, idx);
        }
    }
}

/// API endpoint returning workspace/session state with live metadata.
async fn api_state(
    axum::extract::State(state): axum::extract::State<Arc<RemoteState>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    // Validate token
    let token = params.get("token").map(|s| s.as_str()).unwrap_or("");
    if !auth::validate_token(token, &state.token) {
        return (axum::http::StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    // Read workspace configs from persistent data (for name lookup)
    let workspaces_data = crate::db::storage::load(&state.app_handle)
        .unwrap_or_default();

    // Get live session PIDs and group by workspace ID extracted from session IDs
    let live_pids: Vec<(String, Option<u32>)> = state.app_session_manager.iter_pids();
    let mut ws_groups: std::collections::HashMap<String, Vec<(String, Option<u32>)>> =
        std::collections::HashMap::new();
    for (session_id, pid) in live_pids {
        if let Some(ws_id) = extract_workspace_id(&session_id) {
            ws_groups
                .entry(ws_id.to_string())
                .or_default()
                .push((session_id, pid));
        }
    }

    let mut workspace_order: Vec<String> = Vec::new();
    let live_workspace_ids: std::collections::HashSet<&str> =
        ws_groups.keys().map(|id| id.as_str()).collect();
    for ws in &workspaces_data.workspaces {
        if live_workspace_ids.contains(ws.id.as_str()) {
            workspace_order.push(ws.id.clone());
        }
    }

    let ordered_ids: std::collections::HashSet<&str> =
        workspace_order.iter().map(|id| id.as_str()).collect();
    let mut unknown_ids: Vec<String> = ws_groups
        .keys()
        .filter(|id| !ordered_ids.contains(id.as_str()))
        .cloned()
        .collect();
    unknown_ids.sort();
    workspace_order.extend(unknown_ids);

    let workspaces: Vec<serde_json::Value> = workspace_order
        .into_iter()
        .enumerate()
        .filter_map(|(ws_index, ws_id)| {
            let mut sessions = ws_groups.remove(&ws_id)?;
            sessions.sort_by(|left, right| left.0.cmp(&right.0));

            let ws_config = workspaces_data.workspaces.iter().find(|w| w.id == ws_id);
            let grid_template = ws_config
                .map(|w| w.grid_template_id.clone())
                .unwrap_or_default();

            // Build pane data with labels
            let mut pane_labels: Vec<String> = Vec::new();
            let mut pane_data: Vec<(String, Option<u32>, Option<serde_json::Value>)> = Vec::new();

            for (session_id, pid) in &sessions {
                let (cwd, git_branch, process_name) = if let Some(meta) =
                    state.metadata_store.get(session_id)
                {
                    (
                        Some(meta.cwd.clone()),
                        meta.git_branch.clone(),
                        normalize_process_name(meta.process_name.as_deref()),
                    )
                } else {
                    (None, None, None)
                };

                let label = build_pane_label(
                    session_id,
                    cwd.as_deref(),
                    git_branch.as_deref(),
                    process_name.as_deref(),
                );
                pane_labels.push(label);

                let metadata =
                    if cwd.is_some() || git_branch.is_some() || process_name.is_some() {
                        Some(serde_json::json!({
                            "cwd": cwd,
                            "git_branch": git_branch,
                            "process_name": process_name,
                        }))
                    } else {
                        None
                    };

                pane_data.push((session_id.clone(), *pid, metadata));
            }

            // Deduplicate labels (Terminal → Terminal 1, Terminal 2, ...)
            deduplicate_labels(&mut pane_labels);

            let panes: Vec<serde_json::Value> = pane_data
                .into_iter()
                .zip(pane_labels.iter())
                .map(|((session_id, pid, metadata), label)| {
                    serde_json::json!({
                        "id": "shell",
                        "session_id": session_id,
                        "label": label,
                        "active": pid.is_some(),
                        "metadata": metadata,
                    })
                })
                .collect();

            let name = build_workspace_name(ws_config.map(|w| w.name.as_str()), &pane_labels, ws_index);

            Some(serde_json::json!({
                "id": ws_id,
                "name": name,
                "grid_template": grid_template,
                "panes": panes,
            }))
        })
        .collect();

    axum::Json(serde_json::json!({ "workspaces": workspaces })).into_response()
}

/// Serve the QR code as SVG.
async fn serve_qr(
    axum::extract::State(state): axum::extract::State<Arc<RemoteState>>,
) -> impl axum::response::IntoResponse {
    let port: u16 = std::env::var("MYCMUX_REMOTE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7681);

    let ip = qr::local_ip().unwrap_or_else(|| "localhost".to_string());
    let url = qr::connection_url(&ip, port, &state.token);
    let svg = qr::svg_qr(&url);

    (
        [(axum::http::header::CONTENT_TYPE, "image/svg+xml")],
        svg,
    )
}

/// Serve embedded static client files (index.html, app.js, style.css, manifest.json).
async fn serve_static(uri: axum::http::Uri) -> impl axum::response::IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match ClientAssets::get(path) {
        Some(file) => {
            let mime = match path.rsplit('.').next() {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "application/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("json") => "application/json",
                Some("png") => "image/png",
                _ => "application/octet-stream",
            };
            (
                axum::http::StatusCode::OK,
                [
                    (axum::http::header::CONTENT_TYPE, mime),
                    (axum::http::header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
                ],
                file.data.to_vec(),
            )
                .into_response()
        }
        None => {
            // Fallback to index.html for SPA-style routing
            match ClientAssets::get("index.html") {
                Some(file) => (
                    axum::http::StatusCode::OK,
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/html; charset=utf-8",
                    )],
                    file.data.to_vec(),
                )
                    .into_response(),
                None => (
                    axum::http::StatusCode::NOT_FOUND,
                    Html("<h1>404</h1>".to_string()),
                )
                    .into_response(),
            }
        }
    }
}
