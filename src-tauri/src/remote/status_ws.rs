use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

use super::RemoteState;

const STATUS_RECONCILE_INTERVAL: Duration = Duration::from_secs(90);

#[derive(Deserialize)]
pub struct StatusWsQuery {
    token: String,
}

pub async fn ws_upgrade(
    State(state): State<Arc<RemoteState>>,
    Query(query): Query<StatusWsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !state.control.validate_token(&query.token).await {
        return (axum::http::StatusCode::UNAUTHORIZED, "Invalid token").into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(socket, state))
        .into_response()
}

async fn send_json<T: Serialize>(
    sink: &mut SplitSink<WebSocket, Message>,
    value: &T,
) -> Result<(), ()> {
    let json = serde_json::to_string(value).map_err(|_| ())?;
    sink.send(Message::Text(json.into())).await.map_err(|_| ())
}

async fn handle_ws(socket: WebSocket, state: Arc<RemoteState>) {
    let (mut sink, mut stream) = socket.split();

    let subscribe_request = loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => {
                let request = serde_json::from_str::<crate::status_feed::FeedRequest>(&text);
                match request {
                    Ok(request) => match request.validate("status.subscribe") {
                        Ok(()) => break request,
                        Err(error) => {
                            let response =
                                crate::status_feed::FeedResponseFrame::error(request.id, error);
                            let _ = send_json(&mut sink, &response).await;
                            return;
                        }
                    },
                    Err(error) => {
                        let response = crate::status_feed::FeedResponseFrame::error(
                            0,
                            format!("invalid status.subscribe request: {error}"),
                        );
                        let _ = send_json(&mut sink, &response).await;
                        return;
                    }
                }
            }
            Some(Ok(Message::Ping(payload))) => {
                if sink.send(Message::Pong(payload)).await.is_err() {
                    return;
                }
            }
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
            _ => {}
        }
    };

    let feed = state
        .app_handle
        .state::<crate::AppState>()
        .status_feed
        .clone();
    let (subscription, initial_snapshot) = feed.subscribe();
    let response = crate::status_feed::FeedResponseFrame::success(
        subscribe_request.id,
        serde_json::json!({ "subscribed": true }),
    );
    if send_json(&mut sink, &response).await.is_err()
        || send_json(&mut sink, &initial_snapshot).await.is_err()
    {
        return;
    }

    let mut disconnect_rx = state.control.subscribe_disconnect();
    let first_reconcile = tokio::time::Instant::now() + STATUS_RECONCILE_INTERVAL;
    let mut reconcile = tokio::time::interval_at(first_reconcile, STATUS_RECONCILE_INTERVAL);

    loop {
        tokio::select! {
            event = subscription.recv() => {
                let Some(event) = event else { return };
                if send_json(&mut sink, &event).await.is_err() {
                    return;
                }
            }
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let request = serde_json::from_str::<crate::status_feed::FeedRequest>(&text);
                        let response = match request {
                            Ok(request) => match request.validate("status.snapshot") {
                                Ok(()) => {
                                    let snapshot = feed.resnapshot(&subscription);
                                    crate::status_feed::FeedResponseFrame::success(
                                        request.id,
                                        serde_json::to_value(snapshot).unwrap_or(Value::Null),
                                    )
                                }
                                Err(error) => crate::status_feed::FeedResponseFrame::error(
                                    request.id,
                                    error,
                                ),
                            },
                            Err(error) => crate::status_feed::FeedResponseFrame::error(
                                0,
                                format!("invalid status feed request: {error}"),
                            ),
                        };
                        if send_json(&mut sink, &response).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                    _ => {}
                }
            }
            _ = reconcile.tick() => {
                let snapshot = feed.periodic_snapshot(&subscription);
                if send_json(&mut sink, &snapshot).await.is_err() {
                    return;
                }
            }
            _ = disconnect_rx.recv() => {
                let _ = sink.close().await;
                return;
            }
        }
    }
}
