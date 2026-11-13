//! Native maximize-button hit testing for undecorated Windows WebView windows.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PixelRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RectRejection {
    NonFiniteValue,
    NonPositiveClientSize,
    NonPositiveScale,
    NonPositiveButtonSize,
    NonPositiveViewportSize,
    NegativeX,
    NegativeY,
    RightOverflow,
    BottomOverflow,
    EmptyAfterClipping,
    InvalidPhysicalCoordinates,
    EmptyAfterRounding,
}

impl RectRejection {
    fn as_str(self) -> &'static str {
        match self {
            Self::NonFiniteValue => "non_finite_value",
            Self::NonPositiveClientSize => "non_positive_client_size",
            Self::NonPositiveScale => "non_positive_scale",
            Self::NonPositiveButtonSize => "non_positive_button_size",
            Self::NonPositiveViewportSize => "non_positive_viewport_size",
            Self::NegativeX => "negative_x_at_least_one_css_px",
            Self::NegativeY => "negative_y_at_least_one_css_px",
            Self::RightOverflow => "right_exceeds_viewport",
            Self::BottomOverflow => "bottom_exceeds_viewport",
            Self::EmptyAfterClipping => "empty_after_subpixel_clipping",
            Self::InvalidPhysicalCoordinates => "invalid_physical_coordinates",
            Self::EmptyAfterRounding => "empty_after_rounding_or_client_clamp",
        }
    }
}

fn rejection_message(
    label: &str,
    reason: RectRejection,
    rect: ButtonRect,
    width: i32,
    height: i32,
    scale: f64,
    stage: &str,
) -> String {
    format!(
        "{label}: button rectangle rejected (stage={stage}, reason={}); rect={rect:?}; client={width}x{height}; scale={scale}",
        reason.as_str(),
    )
}

/// Diagnostic episodes are independent of failures that disable native buttons.
#[derive(Default)]
struct RejectedMeasurements {
    windows: HashSet<String>,
}

impl RejectedMeasurements {
    /// Called only for an actual DOM rectangle, never for a withdrawal (`None`).
    fn observe(&mut self, label: &str, rejected: bool) -> bool {
        if rejected {
            self.windows.insert(label.to_string())
        } else {
            self.forget(label);
            false
        }
    }

    fn forget(&mut self, label: &str) {
        self.windows.remove(label);
    }
}

impl ButtonRect {
    /// A WebView can ceil its CSS layout extent at fractional DPI. Capture
    /// the actual native client extent when this DOM measurement arrives;
    /// then keep its exact right inset through later native resize messages.
    fn measured(mut self, width: i32, height: i32, scale: f64) -> Option<Self> {
        self.measure(width, height, scale).ok()?;
        Some(self)
    }

    /// The first validation uses the DOM viewport; the second uses the native client.
    /// Call only for a measurement that has a rejection reason.
    fn rejection_stage(self, width: i32, height: i32, scale: f64) -> &'static str {
        if self.checked_physical(width, height, scale).is_err() {
            "dom"
        } else {
            "native"
        }
    }

    fn rejection_reason(mut self, width: i32, height: i32, scale: f64) -> Option<RectRejection> {
        self.measure(width, height, scale).err()
    }

    fn measure(&mut self, width: i32, height: i32, scale: f64) -> Result<(), RectRejection> {
        self.checked_physical(width, height, scale)?;
        self.viewport_width = width as f64 / scale;
        self.viewport_height = height as f64 / scale;
        self.checked_physical(width, height, scale)?;
        Ok(())
    }

    /// Anchor to the client right edge so native resize/DPI messages need not
    /// wait for a round trip through React. New DOM measurements change inset.
    fn physical(self, width: i32, height: i32, scale: f64) -> Option<PixelRect> {
        self.checked_physical(width, height, scale).ok()
    }

    fn checked_physical(
        mut self,
        width: i32,
        height: i32,
        scale: f64,
    ) -> Result<PixelRect, RectRejection> {
        let numbers = [
            self.x,
            self.y,
            self.width,
            self.height,
            self.viewport_width,
            self.viewport_height,
            scale,
        ];
        if numbers.iter().any(|n| !n.is_finite()) {
            return Err(RectRejection::NonFiniteValue);
        }
        if width <= 0 || height <= 0 {
            return Err(RectRejection::NonPositiveClientSize);
        }
        if scale <= 0.0 {
            return Err(RectRejection::NonPositiveScale);
        }
        if self.width <= 0.0 || self.height <= 0.0 {
            return Err(RectRejection::NonPositiveButtonSize);
        }
        if self.viewport_width <= 0.0 || self.viewport_height <= 0.0 {
            return Err(RectRejection::NonPositiveViewportSize);
        }
        if self.x <= -1.0 {
            return Err(RectRejection::NegativeX);
        }
        if self.y <= -1.0 {
            return Err(RectRejection::NegativeY);
        }
        if self.x + self.width > self.viewport_width + 0.01 {
            return Err(RectRejection::RightOverflow);
        }
        if self.y + self.height > self.viewport_height + 0.01 {
            return Err(RectRejection::BottomOverflow);
        }
        // Fractional DPI can place a centred button just above/left of the
        // viewport. Clip less than one CSS pixel, keeping its far edges fixed.
        if self.x < 0.0 {
            self.width += self.x;
            self.x = 0.0;
        }
        if self.y < 0.0 {
            self.height += self.y;
            self.y = 0.0;
        }
        if self.width <= 0.0 || self.height <= 0.0 {
            return Err(RectRejection::EmptyAfterClipping);
        }
        let inset = (self.viewport_width - self.x - self.width).max(0.0);
        let coordinates = [
            width as f64 - (inset + self.width) * scale,
            self.y * scale,
            width as f64 - inset * scale,
            (self.y + self.height) * scale,
        ];
        if coordinates
            .iter()
            .any(|n| !n.is_finite() || *n < i32::MIN as f64 || *n > i32::MAX as f64)
        {
            return Err(RectRejection::InvalidPhysicalCoordinates);
        }
        let rect = PixelRect {
            left: (coordinates[0].round() as i32).clamp(0, width),
            top: (coordinates[1].round() as i32).clamp(0, height),
            right: (coordinates[2].round() as i32).clamp(0, width),
            bottom: (coordinates[3].round() as i32).clamp(0, height),
        };
        if rect.left < rect.right && rect.top < rect.bottom {
            Ok(rect)
        } else {
            Err(RectRejection::EmptyAfterRounding)
        }
    }
}

impl PixelRect {
    fn contains(self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

// HTMAXBUTTON is stable on both Windows 10 and 11. Only points in the
// declared button override the previous result, including its topmost row.
fn hit_test(rect: Option<PixelRect>, x: i32, y: i32, baseline: isize) -> isize {
    if rect.is_some_and(|rect| rect.contains(x, y)) {
        9
    } else {
        baseline
    }
}

fn screen_point(packed: isize) -> (i32, i32) {
    (
        (packed as u16 as i16) as i32,
        ((packed as usize >> 16) as u16 as i16) as i32,
    )
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
struct ButtonState {
    hovered: bool,
    pressed: bool,
}

impl ButtonState {
    fn press(&mut self) {
        self.hovered = true;
        self.pressed = true;
    }
    fn release(&mut self, inside: bool) -> bool {
        let clicked = self.pressed && inside;
        self.pressed = false;
        self.hovered = inside;
        clicked
    }
    fn cancel(&mut self) -> bool {
        let had_press = self.pressed;
        *self = Self::default();
        had_press
    }
}

/// Async is essential: installing child windows from a synchronous WebView2
/// IPC callback can reenter its controller loop and deadlock the whole app.
#[tauri::command]
pub async fn snap_layouts_update(
    window: tauri::WebviewWindow,
    owner: String,
    rect: Option<ButtonRect>,
) -> Result<bool, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, owner, rect);
        Ok(false)
    }
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        if owner.is_empty() || owner.len() > 100 {
            return Err("Invalid snap button owner".into());
        }
        // A private test profile may inject a failed installation. Production
        // never reads this file, and no new feature or public test command exists.
        let failure = if crate::test_profile::is_active() {
            if let Ok(root) = crate::test_profile::runtime_dir() {
                tokio::fs::read_to_string(root.join("snap-layouts-test-failure.txt"))
                    .await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        let app = window.app_handle().clone();
        crate::tearout::on_ui(&app, move |_| {
            native::update(&window, owner, rect, failure.trim())
        })
        .await
    }
}

#[cfg(target_os = "windows")]
pub fn window_destroyed(label: &str) {
    native::forget_failure(label);
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        collections::HashSet,
        rc::Rc,
        sync::{Mutex, OnceLock},
    };
    use tauri::Emitter;
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::Gdi::ScreenToClient,
            UI::{
                HiDpi::GetDpiForWindow,
                Input::KeyboardAndMouse::{
                    GetCapture, ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE,
                    TME_NONCLIENT, TRACKMOUSEEVENT,
                },
                Shell::{
                    DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass,
                },
                WindowsAndMessaging::*,
            },
        },
    };

    const CLASS: PCWSTR = w!("MYCMUX_SNAP_MAXIMIZE_BUTTON");
    const SUBCLASS_ID: usize = 0x534E4150;
    static FAILURES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    static REJECTIONS: OnceLock<Mutex<RejectedMeasurements>> = OnceLock::new();

    struct NativeState {
        window: tauri::WebviewWindow,
        owner: RefCell<String>,
        logical: Cell<Option<ButtonRect>>,
        pixels: Cell<Option<PixelRect>>,
        child: Cell<HWND>,
        button: Cell<ButtonState>,
        installed: Cell<bool>,
        disabled: Cell<bool>,
    }

    #[derive(Clone, Serialize)]
    struct Notification {
        owner: String,
        hovered: bool,
        pressed: bool,
    }

    impl NativeState {
        fn publish(&self, button: ButtonState) {
            if self.button.replace(button) == button {
                return;
            }
            let payload = Notification {
                owner: self.owner.borrow().clone(),
                hovered: button.hovered,
                pressed: button.pressed,
            };
            let _ = self.window.emit_to(
                tauri::EventTarget::window(self.window.label()),
                "snap-layouts-state",
                payload,
            );
        }
    }

    fn failed(label: &str) -> bool {
        FAILURES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(label)
    }

    fn log_failure(label: &str, reason: &str) {
        let first = FAILURES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.to_string());
        if first {
            crate::diag::warn(
                "snap_layouts",
                &format!("{label}: native button disabled ({reason})"),
            );
        }
    }

    pub fn forget_failure(label: &str) {
        FAILURES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        REJECTIONS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(label);
    }

    unsafe fn clone_context(data: usize) -> Rc<NativeState> {
        let ptr = data as *const NativeState;
        Rc::increment_strong_count(ptr);
        Rc::from_raw(ptr)
    }

    unsafe fn attached(parent: HWND) -> Option<Rc<NativeState>> {
        let mut data = 0;
        if GetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, Some(&mut data)).as_bool()
            && data != 0
        {
            Some(clone_context(data))
        } else {
            None
        }
    }

    fn clear_child(state: &NativeState) {
        let child = state.child.replace(HWND::default());
        if unsafe { IsWindow(child) }.as_bool() {
            let _ = unsafe { DestroyWindow(child) };
        }
    }

    /// The callback owns one Rc; local callback/update clones survive reentry.
    fn detach(parent: HWND, state: &Rc<NativeState>) {
        state.disabled.set(true);
        state.logical.set(None);
        state.pixels.set(None);
        let had_press = state.button.get().pressed;
        state.publish(ButtonState::default());
        if had_press && unsafe { GetCapture() } == parent {
            let _ = unsafe { ReleaseCapture() };
        }
        clear_child(state);
        if state.installed.get()
            && unsafe { RemoveWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID) }.as_bool()
        {
            state.installed.set(false);
            unsafe {
                drop(Rc::from_raw(Rc::as_ptr(state)));
            }
        }
        // On removal failure keep a disabled callback until WM_NCDESTROY. It
        // falls through and still owns its Rc, rather than leaving a dangling pointer.
    }

    fn refresh(parent: HWND, state: &NativeState) -> Result<(), String> {
        let mut client = RECT::default();
        unsafe { GetClientRect(parent, &mut client) }.map_err(|e| e.to_string())?;
        let scale = unsafe { GetDpiForWindow(parent) } as f64 / 96.0;
        let pixels = state
            .logical
            .get()
            .and_then(|r| r.physical(client.right, client.bottom, scale));
        state.pixels.set(pixels);
        let rect = pixels.unwrap_or(PixelRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        });
        unsafe {
            SetWindowPos(
                state.child.get(),
                HWND_TOP,
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOACTIVATE
                    | SWP_NOOWNERZORDER
                    | if pixels.is_some() {
                        SWP_SHOWWINDOW
                    } else {
                        SWP_HIDEWINDOW
                    },
            )
        }
        .map_err(|e| e.to_string())
    }

    pub fn update(
        window: &tauri::WebviewWindow,
        owner: String,
        rect: Option<ButtonRect>,
        failure: &str,
    ) -> Result<bool, String> {
        let parent = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
        let existing = unsafe { attached(parent) };
        if rect.is_none() {
            if let Some(state) = existing {
                if *state.owner.borrow() == owner {
                    detach(parent, &state);
                }
            }
            return Ok(false);
        }
        if failed(window.label()) {
            return Ok(false);
        }
        let mut client = RECT::default();
        if let Err(error) = unsafe { GetClientRect(parent, &mut client) } {
            if let Some(state) = existing {
                detach(parent, &state);
            }
            log_failure(window.label(), &error.to_string());
            return Ok(false);
        }
        let scale = unsafe { GetDpiForWindow(parent) } as f64 / 96.0;
        let rect = rect.and_then(|r| {
            let measured = r.measured(client.right, client.bottom, scale);
            let first = REJECTIONS
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .observe(window.label(), measured.is_none());
            if first {
                if let Some(reason) = r.rejection_reason(client.right, client.bottom, scale) {
                    crate::diag::warn(
                        "snap_layouts",
                        &rejection_message(
                            window.label(), reason, r, client.right, client.bottom, scale,
                            r.rejection_stage(client.right, client.bottom, scale),
                        ),
                    );
                }
            }
            measured
        });
        let state = if let Some(state) = existing {
            if *state.owner.borrow() != owner {
                state.publish(ButtonState::default());
                *state.owner.borrow_mut() = owner;
            }
            state.logical.set(rect);
            state
        } else {
            match install(window, parent, owner, rect, failure) {
                Ok(state) => state,
                Err(error) => {
                    log_failure(window.label(), &error);
                    return Ok(false);
                }
            }
        };
        if let Err(error) = refresh(parent, &state) {
            detach(parent, &state);
            log_failure(window.label(), &error);
            return Ok(false);
        }
        Ok(true)
    }

    fn install(
        window: &tauri::WebviewWindow,
        parent: HWND,
        owner: String,
        rect: Option<ButtonRect>,
        failure: &str,
    ) -> Result<Rc<NativeState>, String> {
        let instance = HINSTANCE(unsafe { GetWindowLongPtrW(parent, GWLP_HINSTANCE) } as *mut _);
        // Registration is process-wide. ERROR_CLASS_ALREADY_EXISTS is harmless;
        // CreateWindowExW below is the authoritative success/failure check.
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(child_proc),
            hInstance: instance,
            lpszClassName: CLASS,
            ..Default::default()
        };
        unsafe { RegisterClassExW(&class) };
        if failure == "create" {
            return Err("test child creation failure".into());
        }
        let child = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE,
                CLASS,
                CLASS,
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                parent,
                None,
                instance,
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        let state = Rc::new(NativeState {
            window: window.clone(),
            owner: RefCell::new(owner),
            logical: Cell::new(rect),
            pixels: Cell::new(None),
            child: Cell::new(child),
            button: Cell::new(ButtonState::default()),
            installed: Cell::new(false),
            disabled: Cell::new(false),
        });
        let context = Rc::into_raw(state.clone());
        if failure == "subclass"
            || !unsafe {
                SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, context as usize)
            }
            .as_bool()
        {
            clear_child(&state);
            unsafe {
                drop(Rc::from_raw(context));
            }
            return Err("parent subclass installation failed".into());
        }
        state.installed.set(true);
        Ok(state)
    }

    unsafe extern "system" fn child_proc(child: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            WM_ERASEBKGND => LRESULT(1),
            _ => DefWindowProcW(child, msg, w, l),
        }
    }

    fn inside(parent: HWND, state: &NativeState, packed: LPARAM, screen: bool) -> bool {
        let (x, y) = screen_point(packed.0);
        let mut point = POINT { x, y };
        if screen && !unsafe { ScreenToClient(parent, &mut point) }.as_bool() {
            return false;
        }
        state
            .pixels
            .get()
            .is_some_and(|r| r.contains(point.x, point.y))
    }

    fn release(parent: HWND, state: &NativeState, inside: bool) {
        let mut button = state.button.get();
        let click = button.release(inside);
        state.publish(button);
        if unsafe { GetCapture() } == parent {
            let _ = unsafe { ReleaseCapture() };
        }
        if click {
            let command = if unsafe { IsZoomed(parent) }.as_bool() {
                SC_RESTORE
            } else {
                SC_MAXIMIZE
            };
            let _ =
                unsafe { PostMessageW(parent, WM_SYSCOMMAND, WPARAM(command as usize), LPARAM(0)) };
        }
    }

    unsafe extern "system" fn parent_proc(
        parent: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        let state = clone_context(data);
        if msg == WM_NCDESTROY {
            state.disabled.set(true);
            clear_child(&state);
            if state.installed.replace(false) {
                let _ = RemoveWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID);
                drop(Rc::from_raw(data as *const NativeState));
            }
            return DefSubclassProc(parent, msg, w, l);
        }
        if state.disabled.get() {
            return DefSubclassProc(parent, msg, w, l);
        }
        match msg {
            WM_NCHITTEST => {
                let baseline = DefSubclassProc(parent, msg, w, l);
                let (x, y) = screen_point(l.0);
                let mut point = POINT { x, y };
                if !ScreenToClient(parent, &mut point).as_bool() {
                    return baseline;
                }
                return LRESULT(hit_test(state.pixels.get(), point.x, point.y, baseline.0));
            }
            WM_NCMOUSEMOVE => {
                let mut button = state.button.get();
                button.hovered = w.0 == HTMAXBUTTON as usize && inside(parent, &state, l, true);
                state.publish(button);
                if button.hovered {
                    let mut tracking = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: parent,
                        ..Default::default()
                    };
                    let _ = TrackMouseEvent(&mut tracking);
                }
                // Default handling is what lets Windows 11 show Snap Layouts.
            }
            WM_NCMOUSELEAVE => {
                let mut button = state.button.get();
                button.hovered = false;
                state.publish(button);
            }
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK
                if w.0 == HTMAXBUTTON as usize && inside(parent, &state, l, true) =>
            {
                let mut button = state.button.get();
                button.press();
                state.publish(button);
                SetCapture(parent);
                return LRESULT(0);
            }
            WM_NCLBUTTONUP if state.button.get().pressed => {
                release(parent, &state, inside(parent, &state, l, true));
                return LRESULT(0);
            }
            WM_MOUSEMOVE if state.button.get().pressed => {
                let mut button = state.button.get();
                button.hovered = inside(parent, &state, l, false);
                state.publish(button);
                return LRESULT(0);
            }
            WM_LBUTTONUP if state.button.get().pressed => {
                release(parent, &state, inside(parent, &state, l, false));
                return LRESULT(0);
            }
            WM_CANCELMODE | WM_KILLFOCUS => {
                let mut button = state.button.get();
                let had_press = button.cancel();
                state.publish(button);
                // A normal caption move can also own this HWND's capture.
                // Never release it unless our maximize press acquired it.
                if had_press && GetCapture() == parent {
                    let _ = ReleaseCapture();
                }
            }
            WM_CAPTURECHANGED if state.button.get().pressed => {
                let mut button = state.button.get();
                button.cancel();
                state.publish(button);
            }
            WM_SIZE | WM_DPICHANGED | WM_WINDOWPOSCHANGED => {
                let result = DefSubclassProc(parent, msg, w, l);
                if state.installed.get() && !state.disabled.get() {
                    if let Err(error) = refresh(parent, &state) {
                        detach(parent, &state);
                        log_failure(state.window.label(), &error);
                    }
                }
                return result;
            }
            _ => {}
        }
        DefSubclassProc(parent, msg, w, l)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button() -> ButtonRect {
        ButtonRect {
            x: 948.0,
            y: 9.0,
            width: 24.0,
            height: 18.0,
            viewport_width: 1000.0,
            viewport_height: 700.0,
        }
    }

    #[test]
    fn rejection_diagnostic_reports_dom_stage() {
        let rect = ButtonRect { x: -1.0, ..button() };
        let reason = rect.rejection_reason(1000, 700, 1.0).unwrap();
        assert_eq!(rect.rejection_stage(1000, 700, 1.0), "dom");
        assert_eq!(
            rejection_message("main", reason, rect, 1000, 700, 1.0,
                rect.rejection_stage(1000, 700, 1.0)),
            format!("main: button rectangle rejected (stage=dom, reason=negative_x_at_least_one_css_px); rect={rect:?}; client=1000x700; scale=1"),
        );
    }

    #[test]
    fn rejection_diagnostic_reports_native_stage_after_rebasing() {
        let rect = ButtonRect {
            x: 0.0, y: 0.0, width: 32.0, height: 32.0,
            viewport_width: 32.0, viewport_height: 32.0,
        };
        for (width, height, reason) in [
            (20, 32, RectRejection::RightOverflow),
            (32, 20, RectRejection::BottomOverflow),
        ] {
            assert_eq!(rect.rejection_reason(width, height, 1.0), Some(reason));
            assert_eq!(rect.rejection_stage(width, height, 1.0), "native");
            assert_eq!(
                rejection_message("mycmux-w2", reason, rect, width, height, 1.0,
                    rect.rejection_stage(width, height, 1.0)),
                format!("mycmux-w2: button rectangle rejected (stage=native, reason={}); rect={rect:?}; client={width}x{height}; scale=1", reason.as_str()),
            );
        }
    }

    #[test]
    fn rejection_stage_keeps_original_dom_validation_failures() {
        for (rect, width, height, scale) in [
            (ButtonRect { x: f64::NAN, ..button() }, 1000, 700, 1.0),
            (button(), 0, 700, 1.0),
            (button(), 1000, 700, 0.0),
            (ButtonRect { x: 999.0, ..button() }, 1000, 700, 1.0),
        ] {
            assert!(rect.rejection_reason(width, height, scale).is_some());
            assert_eq!(rect.rejection_stage(width, height, scale), "dom");
        }
    }

    #[test]
    fn rejection_classifies_every_nonfinite_input() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for field in 0..7 {
                let mut r = button();
                let mut scale = 1.0;
                match field {
                    0 => r.x = bad,
                    1 => r.y = bad,
                    2 => r.width = bad,
                    3 => r.height = bad,
                    4 => r.viewport_width = bad,
                    5 => r.viewport_height = bad,
                    _ => scale = bad,
                }
                assert_eq!(
                    r.rejection_reason(1000, 700, scale),
                    Some(RectRejection::NonFiniteValue)
                );
                assert!(r.measured(1000, 700, scale).is_none());
            }
        }
    }

    #[test]
    fn rejection_classifies_nonpositive_sizes_and_scale() {
        for bad in [0, -1] {
            for (width, height) in [(bad, 700), (1000, bad)] {
                assert_eq!(
                    button().rejection_reason(width, height, 1.0),
                    Some(RectRejection::NonPositiveClientSize)
                );
            }
            assert_eq!(
                button().rejection_reason(1000, 700, bad as f64),
                Some(RectRejection::NonPositiveScale)
            );
            for field in 0..4 {
                let mut r = button();
                match field {
                    0 => r.width = bad as f64,
                    1 => r.height = bad as f64,
                    2 => r.viewport_width = bad as f64,
                    _ => r.viewport_height = bad as f64,
                }
                let expected = if field < 2 {
                    RectRejection::NonPositiveButtonSize
                } else {
                    RectRejection::NonPositiveViewportSize
                };
                assert_eq!(r.rejection_reason(1000, 700, 1.0), Some(expected));
                assert!(r.measured(1000, 700, 1.0).is_none());
            }
        }
    }

    #[test]
    fn rejection_classifies_negative_origins_and_far_edges() {
        for negative in [-1.0, -1.25] {
            for (r, expected) in [
                (
                    ButtonRect {
                        x: negative,
                        ..button()
                    },
                    RectRejection::NegativeX,
                ),
                (
                    ButtonRect {
                        y: negative,
                        ..button()
                    },
                    RectRejection::NegativeY,
                ),
            ] {
                assert_eq!(r.rejection_reason(1000, 700, 1.0), Some(expected));
                assert!(r.measured(1000, 700, 1.0).is_none());
            }
        }
        for (r, expected) in [
            (
                ButtonRect {
                    x: 976.02,
                    ..button()
                },
                RectRejection::RightOverflow,
            ),
            (
                ButtonRect {
                    y: 682.02,
                    ..button()
                },
                RectRejection::BottomOverflow,
            ),
        ] {
            assert_eq!(r.rejection_reason(1000, 700, 1.0), Some(expected));
            assert!(r.measured(1000, 700, 1.0).is_none());
        }
    }

    #[test]
    fn rejection_reason_strings_are_pinned_for_all_variants() {
        let table = [
            (RectRejection::NonFiniteValue, "non_finite_value"),
            (
                RectRejection::NonPositiveClientSize,
                "non_positive_client_size",
            ),
            (RectRejection::NonPositiveScale, "non_positive_scale"),
            (
                RectRejection::NonPositiveButtonSize,
                "non_positive_button_size",
            ),
            (
                RectRejection::NonPositiveViewportSize,
                "non_positive_viewport_size",
            ),
            (RectRejection::NegativeX, "negative_x_at_least_one_css_px"),
            (RectRejection::NegativeY, "negative_y_at_least_one_css_px"),
            (RectRejection::RightOverflow, "right_exceeds_viewport"),
            (RectRejection::BottomOverflow, "bottom_exceeds_viewport"),
            (
                RectRejection::EmptyAfterClipping,
                "empty_after_subpixel_clipping",
            ),
            (
                RectRejection::InvalidPhysicalCoordinates,
                "invalid_physical_coordinates",
            ),
            (
                RectRejection::EmptyAfterRounding,
                "empty_after_rounding_or_client_clamp",
            ),
        ];
        assert_eq!(table.len(), 12);
        for (rejection, expected) in table {
            assert_eq!(rejection.as_str(), expected);
        }
    }

    #[test]
    fn rejection_classifies_clipping_physical_overflow_and_empty_pixels() {
        for r in [
            ButtonRect {
                x: -0.5,
                width: 0.5,
                ..button()
            },
            ButtonRect {
                y: -0.5,
                height: 0.5,
                ..button()
            },
        ] {
            assert_eq!(
                r.rejection_reason(1000, 700, 1.0),
                Some(RectRejection::EmptyAfterClipping)
            );
            assert!(r.measured(1000, 700, 1.0).is_none());
        }
        for scale in [1e20, f64::MAX] {
            assert_eq!(
                button().rejection_reason(1000, 700, scale),
                Some(RectRejection::InvalidPhysicalCoordinates)
            );
            assert!(button().measured(1000, 700, scale).is_none());
        }
        for (r, width, height) in [
            (
                ButtonRect {
                    width: 0.1,
                    ..button()
                },
                1000,
                700,
            ),
            (
                ButtonRect {
                    height: 0.1,
                    ..button()
                },
                1000,
                700,
            ),
            (button(), 20, 700),
            (button(), 1000, 5),
        ] {
            assert_eq!(
                r.rejection_reason(width, height, 1.0),
                Some(RectRejection::EmptyAfterRounding)
            );
            assert!(r.measured(width, height, 1.0).is_none());
        }
    }

    #[test]
    fn rejection_includes_the_second_validation_after_native_rebasing() {
        let r = ButtonRect {
            x: 0.0,
            y: 0.0,
            width: 32.0,
            height: 32.0,
            viewport_width: 32.0,
            viewport_height: 32.0,
        };
        for (width, height, reason) in [
            (20, 32, RectRejection::RightOverflow),
            (32, 20, RectRejection::BottomOverflow),
        ] {
            assert!(r.physical(width, height, 1.0).is_some());
            assert!(r.measured(width, height, 1.0).is_none());
            assert_eq!(r.rejection_reason(width, height, 1.0), Some(reason));
        }
    }

    #[test]
    fn accepted_measurements_have_no_reason_and_keep_the_same_values() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            let width = (1000.0 * scale) as i32;
            let height = (700.0 * scale) as i32;
            for r in [
                button(),
                ButtonRect {
                    x: 0.0,
                    y: 0.0,
                    ..button()
                },
                ButtonRect {
                    x: -0.25,
                    y: -0.5,
                    ..button()
                },
            ] {
                assert_eq!(r.rejection_reason(width, height, scale), None);
                let measured = r.measured(width, height, scale).unwrap();
                assert_eq!(
                    [
                        measured.x,
                        measured.y,
                        measured.width,
                        measured.height,
                        measured.viewport_width,
                        measured.viewport_height
                    ],
                    [r.x, r.y, r.width, r.height, 1000.0, 700.0]
                );
                assert_eq!(
                    measured.physical(width, height, scale),
                    r.physical(width, height, scale)
                );
            }
        }
    }

    #[test]
    fn rejection_episode_warns_once_and_rearms_after_acceptance() {
        let mut episodes = RejectedMeasurements::default();
        assert!(episodes.observe("main", true));
        assert!(!episodes.observe("main", true));
        assert!(!episodes.observe("main", true));
        assert!(!episodes.observe("main", false));
        assert!(episodes.observe("main", true));
        assert!(!episodes.observe("main", true));
    }

    #[test]
    fn rejection_episodes_are_independent_for_each_window() {
        let mut episodes = RejectedMeasurements::default();
        assert!(episodes.observe("main", true));
        assert!(episodes.observe("pane-sample", true));
        assert!(!episodes.observe("main", true));
        assert!(!episodes.observe("pane-sample", true));
        assert!(!episodes.observe("main", false));
        assert!(!episodes.observe("pane-sample", true));
        assert!(episodes.observe("main", true));
    }

    #[test]
    fn destroying_a_window_forgets_only_its_rejection_episode() {
        let mut episodes = RejectedMeasurements::default();
        assert!(episodes.observe("main", true));
        assert!(episodes.observe("pane-sample", true));
        episodes.forget("main");
        episodes.forget("never-seen");
        assert!(episodes.observe("main", true));
        assert!(!episodes.observe("pane-sample", true));
    }

    #[test]
    fn maps_css_to_physical_at_one_and_one_point_five() {
        assert_eq!(
            button().physical(1000, 700, 1.0),
            Some(PixelRect {
                left: 948,
                top: 9,
                right: 972,
                bottom: 27
            })
        );
        assert_eq!(
            button().physical(1500, 1050, 1.5),
            Some(PixelRect {
                left: 1422,
                top: 14,
                right: 1458,
                bottom: 41
            })
        );
    }

    #[test]
    fn follows_resize_before_a_new_dom_measurement() {
        assert_eq!(
            button().physical(800, 500, 1.0),
            Some(PixelRect {
                left: 748,
                top: 9,
                right: 772,
                bottom: 27
            })
        );
        assert_eq!(button().physical(1200, 750, 1.5).unwrap().right, 1158);
    }

    #[test]
    fn fractional_viewport_keeps_odd_physical_width_aligned_at_one_point_five() {
        let r = ButtonRect {
            x: 747.328125,
            viewport_width: 799.328125,
            ..button()
        };
        assert_eq!(
            r.physical(1199, 825, 1.5),
            Some(PixelRect {
                left: 1121,
                top: 14,
                right: 1157,
                bottom: 41
            })
        );
    }

    #[test]
    fn new_layout_updates_the_inset() {
        let mut changed = button();
        changed.x -= 30.0;
        assert_eq!(changed.physical(1000, 700, 1.0).unwrap().left, 918);
    }

    #[test]
    fn boundaries_are_half_open_and_negative_screen_points_are_signed() {
        let r = button().physical(1000, 700, 1.0).unwrap();
        assert!(r.contains(948, 9));
        assert!(r.contains(971, 26));
        for point in [(947, 9), (972, 9), (948, 8), (948, 27)] {
            assert!(!r.contains(point.0, point.1));
        }
        let packed = ((-1440i16 as u16 as u32) << 16) | (-1688i16 as u16 as u32);
        assert_eq!(screen_point(packed as isize), (-1688, -1440));
    }

    #[test]
    fn rejects_nonfinite_empty_and_out_of_view_rectangles() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0] {
            let mut r = button();
            r.width = bad;
            assert_eq!(r.physical(1000, 700, 1.0), None);
        }
        let mut r = button();
        r.x = -1.0;
        assert_eq!(r.physical(1000, 700, 1.0), None);
        r = button();
        r.x = 990.0;
        assert_eq!(r.physical(1000, 700, 1.0), None);
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(button().physical(1000, 700, scale), None);
        }
        assert_eq!(button().physical(0, 700, 1.0), None);
    }

    #[test]
    fn clamps_to_client_area_and_rejects_integer_overflow() {
        assert_eq!(
            button().physical(40, 700, 1.0),
            Some(PixelRect {
                left: 0,
                top: 9,
                right: 12,
                bottom: 27
            })
        );
        assert_eq!(button().physical(20, 700, 1.0), None);
        assert_eq!(button().physical(1000, 10, 1.0).unwrap().bottom, 10);
        assert_eq!(button().physical(1000, 700, 1e20), None);
    }

    #[test]
    fn maximize_overrides_the_whole_button_and_preserves_every_outside_code() {
        let rect = button().physical(1000, 700, 1.0);
        for baseline in [0, 1, 2, 8, 12, 13, 14, 15, 16, 17] {
            assert_eq!(hit_test(rect, 948, 9, baseline), 9);
            assert_eq!(hit_test(rect, 971, 26, baseline), 9);
            assert_eq!(hit_test(rect, 947, 9, baseline), baseline);
            assert_eq!(hit_test(rect, 972, 9, baseline), baseline);
            assert_eq!(hit_test(None, 960, 18, baseline), baseline);
        }
    }

    #[test]
    fn click_requires_press_and_release_inside_and_cancel_resets() {
        let mut state = ButtonState::default();
        assert!(!state.release(true));
        state.press();
        assert!(state.hovered && state.pressed);
        assert!(state.release(true));
        assert!(!state.pressed);
        state.press();
        assert!(!state.release(false));
        assert!(!state.hovered);
        assert!(!state.cancel());
        state.press();
        assert!(state.cancel());
        assert_eq!(state, ButtonState::default());
        assert!(!state.release(true));
    }
    #[test]
    fn integer_webview_viewport_is_rebased_to_the_measured_native_client() {
        let r = ButtonRect {
            x: 742.0,
            y: 8.666666984558105,
            width: 24.0,
            height: 18.0,
            viewport_width: 800.0,
            viewport_height: 550.0,
        };
        let measured = r.measured(1199, 824, 1.5).unwrap();
        assert_eq!(
            measured.physical(1199, 824, 1.5),
            Some(PixelRect {
                left: 1113,
                top: 13,
                right: 1149,
                bottom: 40,
            })
        );
        // Before the next DOM round trip, retain that measured right inset.
        assert_eq!(measured.physical(1301, 950, 1.5).unwrap().right, 1251);
        let wider = r.measured(1201, 826, 1.5).unwrap();
        assert_eq!(wider.physical(1201, 826, 1.5).unwrap().right, 1149);
    }

    #[test]
    fn rebasing_does_not_sanitize_invalid_dom_dimensions() {
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut r = button();
            r.viewport_width = invalid;
            assert!(r.measured(1000, 700, 1.0).is_none());
            r = button();
            r.viewport_height = invalid;
            assert!(r.measured(1000, 700, 1.0).is_none());
        }
        assert!(button().measured(0, 700, 1.0).is_none());
        assert!(button().measured(1000, 0, 1.0).is_none());
        assert!(button().measured(1000, 700, 0.0).is_none());
    }

    #[test]
    fn clips_subpixel_negative_y_without_moving_the_bottom() {
        for (negative, bottoms) in [
            (-0.333, [32, 40, 48, 55, 63]),
            (-0.999, [31, 39, 47, 54, 62]),
            // The captured DOMRect falls just below the half-pixel tie at 150%.
            (-0.3333333432674408, [32, 40, 47, 55, 63]),
        ] {
            for (scale, bottom) in [1.0_f64, 1.25, 1.5, 1.75, 2.0].into_iter().zip(bottoms) {
                let r = ButtonRect {
                    y: negative,
                    height: 32.0,
                    ..button()
                };
                let width = (1000.0 * scale) as i32;
                let height = (700.0 * scale) as i32;
                let expected = Some(PixelRect {
                    left: (948.0 * scale).round() as i32,
                    top: 0,
                    right: (972.0 * scale).round() as i32,
                    bottom,
                });
                assert_eq!(r.physical(width, height, scale), expected);
                let measured = r.measured(width, height, scale).unwrap();
                assert_eq!(measured.physical(width, height, scale), expected);
            }
        }
    }

    #[test]
    fn clips_subpixel_negative_x_without_moving_the_right_edge() {
        for (negative, rights) in [
            (-0.333, [32, 40, 48, 55, 63]),
            (-0.999, [31, 39, 47, 54, 62]),
        ] {
            for (scale, right) in [1.0_f64, 1.25, 1.5, 1.75, 2.0].into_iter().zip(rights) {
                let r = ButtonRect {
                    x: negative,
                    width: 32.0,
                    ..button()
                };
                let width = (1000.0 * scale) as i32;
                let height = (700.0 * scale) as i32;
                let expected = Some(PixelRect {
                    left: 0,
                    top: (9.0 * scale).round() as i32,
                    right,
                    bottom: (27.0 * scale).round() as i32,
                });
                assert_eq!(r.physical(width, height, scale), expected);
                let measured = r.measured(width, height, scale).unwrap();
                assert_eq!(measured.physical(width, height, scale), expected);
            }
        }
    }

    #[test]
    fn rejects_negative_origins_of_one_css_pixel_or_more() {
        for negative in [-1.0, -1.001, -2.0] {
            for r in [
                ButtonRect {
                    x: negative,
                    ..button()
                },
                ButtonRect {
                    y: negative,
                    ..button()
                },
            ] {
                for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
                    assert_eq!(r.physical(2000, 1400, scale), None);
                    assert!(r.measured(2000, 1400, scale).is_none());
                }
            }
        }
    }

    #[test]
    fn clipping_keeps_nonnegative_rectangles_identical_at_all_supported_scales() {
        for (scale, expected) in [
            (
                1.0,
                PixelRect {
                    left: 948,
                    top: 9,
                    right: 972,
                    bottom: 27,
                },
            ),
            (
                1.25,
                PixelRect {
                    left: 1185,
                    top: 11,
                    right: 1215,
                    bottom: 34,
                },
            ),
            (
                1.5,
                PixelRect {
                    left: 1422,
                    top: 14,
                    right: 1458,
                    bottom: 41,
                },
            ),
            (
                1.75,
                PixelRect {
                    left: 1659,
                    top: 16,
                    right: 1701,
                    bottom: 47,
                },
            ),
            (
                2.0,
                PixelRect {
                    left: 1896,
                    top: 18,
                    right: 1944,
                    bottom: 54,
                },
            ),
        ] {
            assert_eq!(
                button().physical((1000.0 * scale) as i32, (700.0 * scale) as i32, scale),
                Some(expected)
            );
        }
        let origin = ButtonRect {
            x: 0.0,
            y: 0.0,
            ..button()
        };
        assert_eq!(
            origin.physical(1000, 700, 1.0),
            Some(PixelRect {
                left: 0,
                top: 0,
                right: 24,
                bottom: 18
            })
        );
    }

    #[test]
    fn clipping_rejects_empty_results_and_preserves_far_edge_validation() {
        for r in [
            ButtonRect {
                x: -0.999,
                width: 0.5,
                ..button()
            },
            ButtonRect {
                y: -0.999,
                height: 0.5,
                ..button()
            },
            ButtonRect {
                x: -0.333,
                width: 1001.0,
                ..button()
            },
            ButtonRect {
                y: -0.333,
                height: 701.0,
                ..button()
            },
            ButtonRect {
                x: -0.5,
                width: 0.5,
                ..button()
            },
            ButtonRect {
                y: -0.5,
                height: 0.5,
                ..button()
            },
        ] {
            assert_eq!(r.physical(1000, 700, 1.0), None);
            assert!(r.measured(1000, 700, 1.0).is_none());
        }
        for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for r in [
                ButtonRect {
                    x: invalid,
                    ..button()
                },
                ButtonRect {
                    y: invalid,
                    ..button()
                },
            ] {
                assert_eq!(r.physical(1000, 700, 1.0), None);
            }
        }
    }

    #[test]
    fn band_rectangles_remain_inside_the_client_at_all_supported_scales() {
        for scale in [1.0_f64, 1.25, 1.5, 1.75, 2.0] {
            // The 1 CSS px bottom border is snapped down to physical pixels.
            let y = -scale.floor() / (2.0 * scale);
            let r = ButtonRect {
                x: 916.0,
                y,
                width: 32.0,
                height: 32.0,
                viewport_width: 986.0,
                viewport_height: 658.0,
            };
            let width = (986.0 * scale).round() as i32;
            let height = (658.0 * scale).round() as i32;
            let measured = r.measured(width, height, scale).unwrap();
            let pixels = measured.physical(width, height, scale).unwrap();
            assert_eq!(pixels.top, 0);
            assert_eq!(pixels.bottom, ((y + 32.0) * scale).round() as i32);
            assert!(0 <= pixels.left && pixels.left < pixels.right && pixels.right <= width);
            assert!(pixels.top < pixels.bottom && pixels.bottom <= height);
            assert_eq!(
                hit_test(
                    Some(pixels),
                    (pixels.left + pixels.right) / 2,
                    (pixels.top + pixels.bottom) / 2,
                    1
                ),
                9
            );
            assert_eq!(
                hit_test(
                    None,
                    (pixels.left + pixels.right) / 2,
                    (pixels.top + pixels.bottom) / 2,
                    1
                ),
                1
            );
        }
    }
}
