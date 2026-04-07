pub mod auth;
pub mod qr;
pub mod session;
pub mod ws_handler;

use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use session::RemoteSessionManager;
use std::sync::Arc;

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
        let port_file = {
            let mut p = dirs::home_dir().unwrap_or_default();
            p.push(".mycmux");
            std::fs::create_dir_all(&p).ok();
            p.push("remote.port");
            p
        };
        let _ = std::fs::write(&port_file, port.to_string());

        // Print connection info + QR
        if let Some(ip) = qr::local_ip() {
            let url = qr::connection_url(&ip, port, &token);
            println!("\n=== mycmux Remote Terminal ===");
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
                return;
            }
        };

        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[remote] Server error: {e}");
        }
    });
}

/// API endpoint returning workspace/session state with live metadata.
async fn api_state(
    axum::extract::State(state): axum::extract::State<Arc<RemoteState>>,
) -> impl IntoResponse {
    // Read workspace configs from persistent data
    let workspaces_data = crate::db::storage::load(&state.app_handle)
        .unwrap_or_default();

    // Get live session PIDs
    let pids: std::collections::HashMap<String, Option<u32>> =
        state.app_session_manager.iter_pids().into_iter().collect();

    // Build response
    let workspaces: Vec<serde_json::Value> = workspaces_data.workspaces.iter().map(|ws| {
        let panes: Vec<serde_json::Value> = ws.panes.iter().enumerate().map(|(i, pane)| {
            let session_id = format!("{}-{}", ws.id, i);
            let metadata = state.metadata_store.get(&session_id).map(|m| {
                serde_json::json!({
                    "cwd": m.cwd,
                    "git_branch": m.git_branch,
                    "process_name": m.process_name,
                })
            });
            let has_pid = pids.get(&session_id).and_then(|p| *p).is_some();
            serde_json::json!({
                "id": pane.agent_id,
                "session_id": session_id,
                "label": pane.label,
                "active": has_pid,
                "metadata": metadata,
            })
        }).collect();

        serde_json::json!({
            "id": ws.id,
            "name": ws.name,
            "grid_template": ws.grid_template_id,
            "panes": panes,
        })
    }).collect();

    axum::Json(serde_json::json!({ "workspaces": workspaces }))
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
                [(axum::http::header::CONTENT_TYPE, mime)],
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
