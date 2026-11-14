//! Capture the calling WKWebView without saving a file or sampling the desktop.
use std::time::Duration;
use base64::Engine;
use block2::RcBlock;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSError};
use objc2_web_kit::WKWebView;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const FAILED: &str = "画面を撮れませんでした";
pub(super) async fn capture(app: &AppHandle, label: &str) -> Result<String, String> {
    let webview = app.get_webview(label).ok_or(FAILED)?;
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, ()>>();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    crate::mac_webview::with_webview(&webview, move |platform| {
        if sender.lock().ok().and_then(|slot| slot.as_ref().map(|tx| tx.is_closed())).unwrap_or(true) { return; }
        let completed = sender.clone();
        let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
            let outcome = if image.is_null() { Err(()) } else {
                // SAFETY: WebKit owns this image for the duration of the callback.
                unsafe { &*image }.TIFFRepresentation()
                    .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                    .and_then(|bitmap| unsafe {
                        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
                    })
                    .map(|png| png.to_vec()).ok_or(())
            };
            if let Some(tx) = completed.lock().ok().and_then(|mut slot| slot.take()) { let _ = tx.send(outcome); }
        });
        // SAFETY: with_webview runs on the main thread and balances the runtime's native handles.
        let view = unsafe { &*(platform.inner() as *const WKWebView) };
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(None, &handler) };
    }).map_err(|_| FAILED)?;
    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(Ok(png))) => Ok(base64::engine::general_purpose::STANDARD.encode(png)),
        _ => Err(FAILED.into()),
    }
}
