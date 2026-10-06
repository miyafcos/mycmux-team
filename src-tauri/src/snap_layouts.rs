//! Native maximize-button hit testing for undecorated Windows WebView windows.
use serde::{Deserialize, Serialize};

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

impl ButtonRect {
    /// A WebView can ceil its CSS layout extent at fractional DPI. Capture
    /// the actual native client extent when this DOM measurement arrives;
    /// then keep its exact right inset through later native resize messages.
    fn measured(mut self, width: i32, height: i32, scale: f64) -> Option<Self> {
        self.physical(width, height, scale)?;
        self.viewport_width = width as f64 / scale;
        self.viewport_height = height as f64 / scale;
        self.physical(width, height, scale)?;
        Some(self)
    }

    /// Anchor to the client right edge so native resize/DPI messages need not
    /// wait for a round trip through React. New DOM measurements change inset.
    fn physical(self, width: i32, height: i32, scale: f64) -> Option<PixelRect> {
        let numbers = [
            self.x,
            self.y,
            self.width,
            self.height,
            self.viewport_width,
            self.viewport_height,
            scale,
        ];
        if numbers.iter().any(|n| !n.is_finite())
            || width <= 0
            || height <= 0
            || scale <= 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.viewport_width <= 0.0
            || self.viewport_height <= 0.0
            || self.x < 0.0
            || self.y < 0.0
            || self.x + self.width > self.viewport_width + 0.01
            || self.y + self.height > self.viewport_height + 0.01
        {
            return None;
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
            return None;
        }
        let rect = PixelRect {
            left: (coordinates[0].round() as i32).clamp(0, width),
            top: (coordinates[1].round() as i32).clamp(0, height),
            right: (coordinates[2].round() as i32).clamp(0, width),
            bottom: (coordinates[3].round() as i32).clamp(0, height),
        };
        (rect.left < rect.right && rect.top < rect.bottom).then_some(rect)
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
        let rect = rect.and_then(|r| r.measured(client.right, client.bottom, scale));
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
}
