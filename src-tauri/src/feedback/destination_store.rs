//! Keep routing in a single OS-protected value, separate from settings and diagnostics.
use std::path::{Path, PathBuf};
use super::{FeedbackError, SecretDestination, SecretStore};

pub(super) struct OsSecretStore { base: PathBuf, service: String }
impl OsSecretStore {
    pub(super) fn new(base: PathBuf) -> Self {
        Self { base, service: format!("mycmux.feedback.{}", crate::test_profile::name().unwrap_or("default")) }
    }
}
impl SecretStore for OsSecretStore {
    fn exists(&self) -> Result<bool, FeedbackError> { platform::exists(&self.base, &self.service) }
    fn read(&self) -> Result<Option<SecretDestination>, FeedbackError> {
        platform::read(&self.base, &self.service)?
            .map(|value| serde_json::from_str(&value).map_err(|_| FeedbackError::Storage)).transpose()
    }
    fn write(&self, value: &SecretDestination) -> Result<(), FeedbackError> {
        let value = serde_json::to_string(value).map_err(|_| FeedbackError::Storage)?;
        platform::write(&self.base, &self.service, &value)
    }
    fn remove(&self) -> Result<(), FeedbackError> { platform::remove(&self.base, &self.service) }
}

#[cfg(all(windows, not(test)))]
use self::windows as platform;

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{ffi::c_void, io::Write, ptr};
    #[repr(C)]
    struct Blob { size: u32, data: *mut u8 }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(input: *const Blob, description: *const u16, entropy: *const Blob,
            reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut Blob) -> i32;
        fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob,
            reserved: *mut c_void, prompt: *const c_void, flags: u32, output: *mut Blob) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" { fn LocalFree(memory: *mut c_void) -> *mut c_void; }
    fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, FeedbackError> {
        let input = Blob { size: bytes.len().try_into().map_err(|_| FeedbackError::Storage)?, data: bytes.as_ptr() as *mut u8 };
        let mut output = Blob { size: 0, data: ptr::null_mut() };
        let ok = unsafe {
            if decrypt { CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null(), 1, &mut output) }
            else { CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null(), 1, &mut output) }
        };
        if ok == 0 { return Err(FeedbackError::Storage); }
        let value = if output.size == 0 { vec![] } else {
            unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() }
        };
        unsafe { LocalFree(output.data.cast()); }
        Ok(value)
    }
    pub(super) fn exists(base: &Path, _service: &str) -> Result<bool, FeedbackError> {
        base.join("feedback-destination.bin").try_exists().map_err(|_| FeedbackError::Storage)
    }
    pub(super) fn read(base: &Path, _service: &str) -> Result<Option<String>, FeedbackError> {
        let bytes = match std::fs::read(base.join("feedback-destination.bin")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(FeedbackError::Storage),
        };
        String::from_utf8(protect(&bytes, true)?).map(Some).map_err(|_| FeedbackError::Storage)
    }
    pub(super) fn write(base: &Path, _service: &str, value: &str) -> Result<(), FeedbackError> {
        std::fs::create_dir_all(base).map_err(|_| FeedbackError::Storage)?;
        let mut file = tempfile::NamedTempFile::new_in(base).map_err(|_| FeedbackError::Storage)?;
        file.write_all(&protect(value.as_bytes(), false)?).map_err(|_| FeedbackError::Storage)?;
        file.as_file().sync_all().map_err(|_| FeedbackError::Storage)?;
        file.persist(base.join("feedback-destination.bin")).map_err(|_| FeedbackError::Storage)?;
        Ok(())
    }
    pub(super) fn remove(base: &Path, _service: &str) -> Result<(), FeedbackError> {
        match std::fs::remove_file(base.join("feedback-destination.bin")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(FeedbackError::Storage),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn dpapi_roundtrips_replaces_and_removes_in_a_temporary_directory() {
            let dir = tempfile::tempdir().unwrap();
            let value = r#"{"token":"xoxb-test-fake","destination":"C000TEST1"}"#;
            assert!(!exists(dir.path(), "test").unwrap());
            assert_eq!(read(dir.path(), "test").unwrap(), None);
            write(dir.path(), "test", value).unwrap();
            assert!(exists(dir.path(), "test").unwrap());
            assert_eq!(read(dir.path(), "test").unwrap().as_deref(), Some(value));
            let bytes = std::fs::read(dir.path().join("feedback-destination.bin")).unwrap();
            assert!(!bytes.windows(value.len()).any(|part| part == value.as_bytes()));
            assert!(!bytes.windows(b"xoxb-test-fake".len()).any(|part| part == b"xoxb-test-fake"));
            write(dir.path(), "test", "replacement").unwrap();
            assert_eq!(read(dir.path(), "test").unwrap().as_deref(), Some("replacement"));
            remove(dir.path(), "test").unwrap();
            remove(dir.path(), "test").unwrap();
            assert!(!exists(dir.path(), "test").unwrap());
        }
        #[test]
        fn unreadable_dpapi_value_still_has_presence_and_can_be_removed() {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("feedback-destination.bin"), b"not-a-protected-value").unwrap();
            assert!(exists(dir.path(), "test").unwrap());
            assert!(read(dir.path(), "test").is_err());
            remove(dir.path(), "test").unwrap();
            assert!(!exists(dir.path(), "test").unwrap());
        }
    }
}

#[cfg(all(target_os = "macos", not(test)))]
mod platform {
    use super::*;
    use std::{ffi::c_void, ptr};
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainFindGenericPassword(keychain: *const c_void, service_len: u32, service: *const u8,
            account_len: u32, account: *const u8, length: *mut u32, data: *mut *mut c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainAddGenericPassword(keychain: *const c_void, service_len: u32, service: *const u8,
            account_len: u32, account: *const u8, length: u32, data: *const c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainItemModifyAttributesAndData(item: *const c_void, attributes: *const c_void, length: u32, data: *const c_void) -> i32;
        fn SecKeychainItemFreeContent(attributes: *const c_void, data: *const c_void) -> i32;
        fn SecKeychainItemDelete(item: *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" { fn CFRelease(value: *const c_void); }
    const ACCOUNT: &[u8] = b"destination";
    pub(super) fn exists(_base: &Path, service: &str) -> Result<bool, FeedbackError> {
        let mut item = ptr::null_mut();
        // Request only an item reference, never password length or password data.
        let status = unsafe { SecKeychainFindGenericPassword(ptr::null(), service.len() as u32, service.as_ptr(),
            ACCOUNT.len() as u32, ACCOUNT.as_ptr(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        if status == -25300 { return Ok(false); }
        if status != 0 { return Err(FeedbackError::Storage); }
        if !item.is_null() { unsafe { CFRelease(item); } }
        Ok(true)
    }
    pub(super) fn read(_base: &Path, service: &str) -> Result<Option<String>, FeedbackError> {
        let mut length = 0;
        let mut data = ptr::null_mut();
        let status = unsafe { SecKeychainFindGenericPassword(ptr::null(), service.len() as u32, service.as_ptr(),
            ACCOUNT.len() as u32, ACCOUNT.as_ptr(), &mut length, &mut data, ptr::null_mut()) };
        if status == -25300 { return Ok(None); }
        if status != 0 { return Err(FeedbackError::Storage); }
        let bytes = if length == 0 { vec![] } else { unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize).to_vec() } };
        unsafe { SecKeychainItemFreeContent(ptr::null(), data); }
        String::from_utf8(bytes).map(Some).map_err(|_| FeedbackError::Storage)
    }
    pub(super) fn write(_base: &Path, service: &str, value: &str) -> Result<(), FeedbackError> {
        let mut item = ptr::null_mut();
        let found = unsafe { SecKeychainFindGenericPassword(ptr::null(), service.len() as u32, service.as_ptr(),
            ACCOUNT.len() as u32, ACCOUNT.as_ptr(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        let status = unsafe {
            if found == 0 {
                let status = SecKeychainItemModifyAttributesAndData(item, ptr::null(), value.len() as u32, value.as_ptr().cast());
                CFRelease(item);
                status
            } else if found == -25300 {
                SecKeychainAddGenericPassword(ptr::null(), service.len() as u32, service.as_ptr(),
                    ACCOUNT.len() as u32, ACCOUNT.as_ptr(), value.len() as u32, value.as_ptr().cast(), ptr::null_mut())
            } else { found }
        };
        if status == 0 { Ok(()) } else { Err(FeedbackError::Storage) }
    }
    pub(super) fn remove(_base: &Path, service: &str) -> Result<(), FeedbackError> {
        let mut item = ptr::null_mut();
        let found = unsafe { SecKeychainFindGenericPassword(ptr::null(), service.len() as u32, service.as_ptr(),
            ACCOUNT.len() as u32, ACCOUNT.as_ptr(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        if found == -25300 { return Ok(()); }
        if found != 0 { return Err(FeedbackError::Storage); }
        let status = unsafe { let status = SecKeychainItemDelete(item); CFRelease(item); status };
        if status == 0 { Ok(()) } else { Err(FeedbackError::Storage) }
    }
}

// Unit tests always inject a test store. A mistakenly invoked command must not touch the real OS store.
#[cfg(any(test, not(any(windows, target_os = "macos"))))]
mod platform {
    use super::*;
    pub(super) fn exists(_base: &Path, _service: &str) -> Result<bool, FeedbackError> { Err(FeedbackError::Storage) }
    pub(super) fn read(_base: &Path, _service: &str) -> Result<Option<String>, FeedbackError> { Err(FeedbackError::Storage) }
    pub(super) fn write(_base: &Path, _service: &str, _value: &str) -> Result<(), FeedbackError> { Err(FeedbackError::Storage) }
    pub(super) fn remove(_base: &Path, _service: &str) -> Result<(), FeedbackError> { Err(FeedbackError::Storage) }
}
