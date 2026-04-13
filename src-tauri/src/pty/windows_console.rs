#[cfg(target_os = "windows")]
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
#[cfg(target_os = "windows")]
use std::sync::OnceLock;
#[cfg(target_os = "windows")]
use std::thread;
#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(target_os = "windows")]
use sysinfo::{ProcessesToUpdate, System};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumWindows, GetMessageW, GetWindowThreadProcessId, HWND_BOTTOM,
    IsWindowVisible, MSG, SetWindowPos, ShowWindow, SW_HIDE, SWP_HIDEWINDOW, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, TranslateMessage, WINEVENT_OUTOFCONTEXT,
    EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW,
};

#[cfg(target_os = "windows")]
struct WindowHideState {
    target_pids: HashMap<u32, String>,
}

#[cfg(target_os = "windows")]
fn should_hide_console_process(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "openconsole.exe"
            | "conhost.exe"
            | "cmd.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "bash.exe"
            | "sh.exe"
            | "zsh.exe"
            | "fish.exe"
            | "nu.exe"
            | "nushell.exe"
    )
}

#[cfg(target_os = "windows")]
static FLASH_SUPPRESSION_ROOT_PID: AtomicU32 = AtomicU32::new(0);
#[cfg(target_os = "windows")]
static FLASH_EVENT_HOOK_STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static PROCESS_SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

#[cfg(target_os = "windows")]
unsafe extern "system" fn hide_descendant_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut WindowHideState);
    let mut pid = 0u32;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != 0
        && IsWindowVisible(hwnd).as_bool()
        && state
            .target_pids
            .get(&pid)
            .is_some_and(|name| should_hide_console_process(name))
    {
        let _ = ShowWindow(hwnd, SW_HIDE);
        let _ = SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
    BOOL(1)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn hide_openconsole_on_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if hwnd.0.is_null() || id_object != 0 {
        return;
    }
    let root_pid = FLASH_SUPPRESSION_ROOT_PID.load(Ordering::Relaxed);
    if root_pid == 0 {
        return;
    }
    hide_window_if_openconsole_descendant(hwnd, root_pid);
}

#[cfg(target_os = "windows")]
fn build_parent_map(sys: &System) -> HashMap<u32, Option<u32>> {
    sys.processes()
        .iter()
        .map(|(pid, process)| (pid.as_u32(), process.parent().map(|parent| parent.as_u32())))
        .collect()
}

#[cfg(target_os = "windows")]
fn descendant_pids(parent_map: &HashMap<u32, Option<u32>>, root_pid: u32) -> Vec<u32> {
    let mut result = vec![root_pid];
    let mut changed = true;

    while changed {
        changed = false;
        for (pid, parent) in parent_map {
            if result.contains(pid) {
                continue;
            }
            if parent.is_some_and(|parent_pid| result.contains(&parent_pid)) {
                result.push(*pid);
                changed = true;
            }
        }
    }

    result
}

#[cfg(target_os = "windows")]
fn refresh_target_pids(sys: &mut System, root_pid: u32) -> HashMap<u32, String> {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let parent_map = build_parent_map(sys);
    let pids = descendant_pids(&parent_map, root_pid);
    pids
        .into_iter()
        .filter_map(|pid| {
            sys.process(sysinfo::Pid::from_u32(pid))
                .map(|process| (pid, process.name().to_string_lossy().to_string()))
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn hide_window_if_openconsole_descendant(hwnd: HWND, root_pid: u32) {
    let sys = PROCESS_SYSTEM.get_or_init(|| Mutex::new(System::new()));
    let mut sys = match sys.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let target_pids = refresh_target_pids(&mut sys, root_pid);
    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if pid == 0 {
        return;
    }
    if target_pids
        .get(&pid)
        .is_some_and(|name| should_hide_console_process(name))
    {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
            let _ = SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn maybe_hide_descendant_windows(sys: &mut System, root_pid: u32) {
    let target_pids = refresh_target_pids(sys, root_pid);
    let mut state = WindowHideState { target_pids };

    unsafe {
        let _ = EnumWindows(
            Some(hide_descendant_window),
            LPARAM((&mut state as *mut WindowHideState) as isize),
        );
    }
}

#[cfg(target_os = "windows")]
fn ensure_flash_event_hook(root_pid: u32) {
    FLASH_SUPPRESSION_ROOT_PID.store(root_pid, Ordering::Relaxed);
    if FLASH_EVENT_HOOK_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    thread::spawn(|| unsafe {
        let hook_show = SetWinEventHook(
            EVENT_OBJECT_SHOW,
            EVENT_OBJECT_SHOW,
            None,
            Some(hide_openconsole_on_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let hook_create = SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_CREATE,
            None,
            Some(hide_openconsole_on_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );

        if hook_show.is_invalid() && hook_create.is_invalid() {
            FLASH_EVENT_HOOK_STARTED.store(false, Ordering::Release);
            return;
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            let _ = DispatchMessageW(&msg);
        }

        if !hook_show.is_invalid() {
            let _ = UnhookWinEvent(hook_show);
        }
        if !hook_create.is_invalid() {
            let _ = UnhookWinEvent(hook_create);
        }
        FLASH_EVENT_HOOK_STARTED.store(false, Ordering::Release);
    });
}

#[cfg(target_os = "windows")]
fn run_suppression_loop(root_pid: u32, iterations: usize, sleep_ms: u64) {
    thread::spawn(move || {
        let mut sys = System::new();
        for _ in 0..iterations {
            maybe_hide_descendant_windows(&mut sys, root_pid);
            thread::sleep(Duration::from_millis(sleep_ms));
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn run_suppression_loop(_root_pid: u32, _iterations: usize, _sleep_ms: u64) {}

#[cfg(target_os = "windows")]
pub fn start_startup_flash_suppression(root_pid: u32) {
    ensure_flash_event_hook(root_pid);
    run_suppression_loop(root_pid, 4000, 1);
}

#[cfg(not(target_os = "windows"))]
pub fn start_startup_flash_suppression(_root_pid: u32) {}

#[cfg(target_os = "windows")]
pub fn suppress_spawn_flash(root_pid: u32) {
    ensure_flash_event_hook(root_pid);
    run_suppression_loop(root_pid, 1500, 1);
}

#[cfg(not(target_os = "windows"))]
pub fn suppress_spawn_flash(_root_pid: u32) {}
