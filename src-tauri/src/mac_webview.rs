//! Balance the three +1 native handles leaked by tauri-runtime-wry 2.10.1.
//!
//! Its with_webview branch calls Retained::into_raw for WKWebView, the
//! WKUserContentController and NSWindow. PlatformWebview has no Drop. Take
//! each handle exactly once inside its main-thread closure, and release at
//! closure exit (including unwinding). Do NOT use retain() here.
//! The Python ownership contract pins tauri-runtime-wry = 2.10.1: an upstream
//! ownership fix must fail that test before these from_raw calls can overrelease.
use objc2::{rc::Retained, runtime::AnyObject};
use tauri::webview::PlatformWebview;

pub(crate) fn with_webview<F>(view: &tauri::Webview, callback: F) -> tauri::Result<()>
where
    F: FnOnce(PlatformWebview) + Send + 'static,
{
    view.with_webview(move |platform| {
        // SAFETY: the pinned runtime creates precisely these three +1 objects.
        // They stay owned for this whole callback; any async native work must
        // retain its own handles rather than keep a borrowed raw pointer.
        let _view = unsafe { Retained::<AnyObject>::from_raw(platform.inner().cast()) };
        let _controller = unsafe { Retained::<AnyObject>::from_raw(platform.controller().cast()) };
        let _window = unsafe { Retained::<AnyObject>::from_raw(platform.ns_window().cast()) };
        callback(platform);
    })
}
