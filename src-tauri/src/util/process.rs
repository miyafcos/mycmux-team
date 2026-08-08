//! Process-spawn constants shared by every helper process we launch.

/// Windows `CREATE_NO_WINDOW` creation flag.
///
/// Without it every short-lived console helper (git, crsm, taskkill, the
/// tailscale probe, the tab-sweep judge) flashes a console window on top of
/// the app. Pass it via `std::os::windows::process::CommandExt::creation_flags`.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
