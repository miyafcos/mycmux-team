//! API keys never enter data.json, localStorage, settings responses or logs.
use std::path::Path;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, fs, ptr};
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
    fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
        let input = Blob { size: bytes.len().try_into().map_err(|_| "key_storage")?, data: bytes.as_ptr() as *mut u8 };
        let mut output = Blob { size: 0, data: ptr::null_mut() };
        // CRYPTPROTECT_UI_FORBIDDEN; default protection binds to the current OS user.
        let ok = unsafe {
            if decrypt { CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null_mut(), ptr::null(), 1, &mut output) }
            else { CryptProtectData(&input, ptr::null(), ptr::null(), ptr::null_mut(), ptr::null(), 1, &mut output) }
        };
        if ok == 0 { return Err("key_storage".into()); }
        let result = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
        unsafe { LocalFree(output.data.cast()); }
        Ok(result)
    }
    pub fn read(dir: &Path, _target: &str) -> Result<Option<String>, String> {
        let bytes = match fs::read(dir.join("jev-key.bin")) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("key_storage".into()),
        };
        String::from_utf8(protect(&bytes, true)?).map(Some).map_err(|_| "key_storage".into())
    }
    pub fn write(dir: &Path, _target: &str, key: &str) -> Result<(), String> {
        use std::io::Write;
        fs::create_dir_all(dir).map_err(|_| "key_storage")?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|_| "key_storage")?;
        file.write_all(&protect(key.as_bytes(), false)?).map_err(|_| "key_storage")?;
        file.as_file().sync_all().map_err(|_| "key_storage")?;
        file.persist(dir.join("jev-key.bin")).map_err(|_| "key_storage")?;
        Ok(())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn protected_key_roundtrips_without_plaintext_on_disk() {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(read(dir.path(), "test").unwrap(), None);
            write(dir.path(), "test", "unit-test-only-value").unwrap();
            assert_eq!(read(dir.path(), "test").unwrap().as_deref(), Some("unit-test-only-value"));
            let bytes = fs::read(dir.path().join("jev-key.bin")).unwrap();
            assert!(!bytes.windows(20).any(|w| w == b"unit-test-only-value"));
            write(dir.path(), "test", "replacement").unwrap();
            assert_eq!(read(dir.path(), "test").unwrap().as_deref(), Some("replacement"));
        }
    }
}

#[cfg(target_os = "macos")]
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
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" { fn CFRelease(value: *const c_void); }
    const ACCOUNT: &[u8] = b"openrouter";
    pub fn read(_dir: &Path, target: &str) -> Result<Option<String>, String> {
        let mut length = 0;
        let mut data = ptr::null_mut();
        let status = unsafe { SecKeychainFindGenericPassword(ptr::null(), target.len() as u32, target.as_ptr(),
            ACCOUNT.len() as u32, ACCOUNT.as_ptr(), &mut length, &mut data, ptr::null_mut()) };
        if status == -25300 { return Ok(None); }
        if status != 0 { return Err("key_storage".into()); }
        let bytes = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize).to_vec() };
        unsafe { SecKeychainItemFreeContent(ptr::null(), data); }
        String::from_utf8(bytes).map(Some).map_err(|_| "key_storage".into())
    }
    pub fn write(_dir: &Path, target: &str, key: &str) -> Result<(), String> {
        let mut item = ptr::null_mut();
        let found = unsafe { SecKeychainFindGenericPassword(ptr::null(), target.len() as u32, target.as_ptr(),
            ACCOUNT.len() as u32, ACCOUNT.as_ptr(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        let status = unsafe {
            if found == 0 {
                let status = SecKeychainItemModifyAttributesAndData(item, ptr::null(), key.len() as u32, key.as_ptr().cast());
                CFRelease(item);
                status
            } else if found == -25300 {
                SecKeychainAddGenericPassword(ptr::null(), target.len() as u32, target.as_ptr(), ACCOUNT.len() as u32,
                    ACCOUNT.as_ptr(), key.len() as u32, key.as_ptr().cast(), ptr::null_mut())
            } else { found }
        };
        if status == 0 { Ok(()) } else { Err("key_storage".into()) }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;
    use std::{io::Write, process::{Command, Stdio}};
    pub fn read(_dir: &Path, target: &str) -> Result<Option<String>, String> {
        let output = Command::new("secret-tool").args(["lookup", "application", target, "account", "openrouter"])
            .stderr(Stdio::null()).output().map_err(|_| "key_storage")?;
        if output.status.code() == Some(1) { return Ok(None); }
        if !output.status.success() { return Err("key_storage".into()); }
        String::from_utf8(output.stdout).map(|s| Some(s.trim_end().to_string())).map_err(|_| "key_storage".into())
    }
    pub fn write(_dir: &Path, target: &str, key: &str) -> Result<(), String> {
        let mut child = Command::new("secret-tool").args(["store", "--label=mycmux Jev (OpenRouter)", "application", target, "account", "openrouter"])
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "key_storage")?;
        child.stdin.take().ok_or("key_storage")?.write_all(key.as_bytes()).map_err(|_| "key_storage")?;
        if child.wait().map_err(|_| "key_storage")?.success() { Ok(()) } else { Err("key_storage".into()) }
    }
}
pub(super) use platform::{read, write};
