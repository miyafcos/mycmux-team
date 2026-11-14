//! Small cross-cutting helpers shared by several modules.
//!
//! Anything here must stay dependency-free with respect to the rest of the
//! crate (no `AppState`, no Tauri commands) so it can be pulled in from
//! `commands`, `pty`, `db`, and `cli_accounts` alike.

pub mod atomic_write;
pub mod ids;
pub mod process;
pub mod task;

// Keep the Windows file-information ABI identical for archive identities and
// account-home hard-link checks without requiring another Windows feature.
#[cfg(windows)]
pub(crate) mod windows_file_information {
    #[repr(C)]
    #[derive(Default)]
    struct FileTime { low: u32, high: u32 }

    #[repr(C)]
    #[derive(Default)]
    pub(crate) struct FileInformation {
        attributes: u32, creation: FileTime, access: FileTime, write: FileTime,
        pub(crate) volume: u32,
        size_high: u32, size_low: u32,
        pub(crate) links: u32,
        pub(crate) index_high: u32,
        pub(crate) index_low: u32,
    }
    impl FileInformation {
        pub(crate) fn as_mut_ptr(&mut self) -> *mut Self { self }
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub(crate) fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInformation) -> i32;
    }
}
