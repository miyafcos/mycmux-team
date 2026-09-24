//! Per-user, alternate-only Windows Open With registration.

use std::collections::HashSet;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_NONE, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

const TYPES: [(&str, &str, &str); 4] = [
    (".md", "mycmux.markdown", "Markdown (mycmux)"),
    (".markdown", "mycmux.markdown", "Markdown (mycmux)"),
    (".html", "mycmux.html", "HTML (mycmux)"),
    (".htm", "mycmux.html", "HTML (mycmux)"),
];
const PRODUCTION_BASE: &str = "Software\\Classes";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryValue {
    pub key: String,
    pub name: String,
    pub value: String,
    pub empty: bool,
}

impl RegistryValue {
    fn string(key: String, name: &str, value: String) -> Self {
        Self {
            key,
            name: name.into(),
            value,
            empty: false,
        }
    }

    fn empty(key: String, name: &str) -> Self {
        Self {
            key,
            name: name.into(),
            value: String::new(),
            empty: true,
        }
    }
}

pub fn registration_values(base: &str, exe: &Path) -> Vec<RegistryValue> {
    let exe = exe.to_string_lossy();
    let command = format!("\"{exe}\" \"%1\"");
    let icon = format!("\"{exe}\",0");
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    for (_, prog_id, description) in TYPES {
        if !seen.insert(prog_id) {
            continue;
        }
        let key = format!("{base}\\{prog_id}");
        values.push(RegistryValue::string(key.clone(), "", description.into()));
        values.push(RegistryValue::string(
            format!("{key}\\DefaultIcon"),
            "",
            icon.clone(),
        ));
        values.push(RegistryValue::string(
            format!("{key}\\shell\\open\\command"),
            "",
            command.clone(),
        ));
    }
    for (ext, prog_id, _) in TYPES {
        values.push(RegistryValue::empty(
            format!("{base}\\{ext}\\OpenWithProgids"),
            prog_id,
        ));
    }
    let app = format!("{base}\\Applications\\mycmux.exe");
    values.push(RegistryValue::string(
        app.clone(),
        "FriendlyAppName",
        "mycmux".into(),
    ));
    for (ext, _, _) in TYPES {
        values.push(RegistryValue::empty(format!("{app}\\SupportedTypes"), ext));
    }
    values.push(RegistryValue::string(
        format!("{app}\\shell\\open\\command"),
        "",
        command,
    ));
    values
}

pub fn is_installed_release(debug: bool, profile: Option<&str>, exe: &Path) -> bool {
    !debug
        && profile.is_none()
        && exe
            .parent()
            .is_some_and(|dir| dir.join("uninstall.exe").is_file())
}

pub fn register_in_background(profile: Option<&str>) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if !is_installed_release(cfg!(debug_assertions), profile, &exe) {
        return;
    }
    std::thread::spawn(move || {
        if let Err(error) = register(&exe) {
            crate::diag_warn!("open-with", "Windows registration failed: {error}");
        }
    });
}

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn expected_bytes(value: &RegistryValue) -> (REG_VALUE_TYPE, Vec<u8>) {
    if value.empty {
        return (REG_NONE, Vec::new());
    }
    let bytes = wide(&value.value)
        .into_iter()
        .flat_map(u16::to_le_bytes)
        .collect();
    (REG_SZ, bytes)
}

fn differs(
    key: HKEY,
    name: PCWSTR,
    value: &RegistryValue,
    expected: &[u8],
    kind: REG_VALUE_TYPE,
) -> bool {
    let mut actual_kind = REG_NONE;
    let mut len = 0u32;
    let status = unsafe {
        RegQueryValueExW(
            key,
            name,
            None,
            Some(&mut actual_kind),
            None,
            Some(&mut len),
        )
    };
    if status != ERROR_SUCCESS {
        return true;
    }
    let mut actual = vec![0u8; len as usize];
    let status = unsafe {
        RegQueryValueExW(
            key,
            name,
            None,
            Some(&mut actual_kind),
            if actual.is_empty() {
                None
            } else {
                Some(actual.as_mut_ptr())
            },
            Some(&mut len),
        )
    };
    if status != ERROR_SUCCESS {
        return true;
    }
    actual.truncate(len as usize);
    if value.empty {
        // Windows accepts either REG_NONE or an empty REG_SZ for OpenWithProgids.
        return !((actual_kind == REG_NONE && actual.is_empty())
            || (actual_kind == REG_SZ && actual == [0, 0]));
    }
    actual_kind != kind || actual != expected
}

fn register(exe: &Path) -> Result<(), String> {
    let outcome = register_under(PRODUCTION_BASE, exe);
    let changed = match &outcome {
        Ok(changed) => *changed,
        Err(error) => error.changed,
    };
    if changed {
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
    }
    outcome.map(|_| ()).map_err(|error| error.message)
}

#[derive(Debug)]
struct RegistrationError {
    message: String,
    changed: bool,
}

fn register_under(base: &str, exe: &Path) -> Result<bool, RegistrationError> {
    let mut changed = false;
    for value in registration_values(base, exe) {
        let key_name = wide(&value.key);
        let value_name = wide(&value.name);
        let mut raw = HKEY::default();
        let mut status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key_name.as_ptr()),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                &mut raw,
            )
        };
        if status != ERROR_SUCCESS {
            status = unsafe {
                RegCreateKeyW(HKEY_CURRENT_USER, PCWSTR(key_name.as_ptr()), &mut raw)
            };
            if status == ERROR_SUCCESS {
                changed = true;
            }
        }
        if status != ERROR_SUCCESS {
            return Err(RegistrationError {
                message: format!("{}: {status:?}", value.key),
                changed,
            });
        }
        let key = Key(raw);
        let (kind, bytes) = expected_bytes(&value);
        if differs(key.0, PCWSTR(value_name.as_ptr()), &value, &bytes, kind) {
            let status = unsafe {
                RegSetValueExW(key.0, PCWSTR(value_name.as_ptr()), 0, kind, Some(&bytes))
            };
            if status != ERROR_SUCCESS {
                return Err(RegistrationError {
                    message: format!("{}\\{}: {status:?}", value.key, value.name),
                    changed,
                });
            }
            changed = true;
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::RegDeleteTreeW;

    struct TestRegistryRoot {
        parent: String,
    }

    impl TestRegistryRoot {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            Self {
                parent: format!("Software\\mycmux-open-with-test-{}-{nonce}", std::process::id()),
            }
        }

        fn classes(&self) -> String {
            format!("{}\\Classes", self.parent)
        }
    }

    impl Drop for TestRegistryRoot {
        fn drop(&mut self) {
            let path = wide(&self.parent);
            let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr())) };
            let cleaned = status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND;
            if std::thread::panicking() {
                if !cleaned {
                    eprintln!("test registry cleanup failed for {}: {status:?}", self.parent);
                }
            } else {
                assert!(cleaned, "test registry cleanup failed for {}: {status:?}", self.parent);
            }
        }
    }

    fn read_registry_value(value: &RegistryValue) -> (REG_VALUE_TYPE, Vec<u8>) {
        let path = wide(&value.key);
        let name = wide(&value.name);
        let mut raw = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), 0, KEY_QUERY_VALUE, &mut raw)
        };
        assert_eq!(status, ERROR_SUCCESS, "missing key: {}", value.key);
        let key = Key(raw);
        let mut kind = REG_NONE;
        let mut len = 0u32;
        let status = unsafe {
            RegQueryValueExW(key.0, PCWSTR(name.as_ptr()), None, Some(&mut kind), None, Some(&mut len))
        };
        assert_eq!(status, ERROR_SUCCESS, "missing value: {}\\{}", value.key, value.name);
        let mut bytes = vec![0u8; len as usize];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                None,
                Some(&mut kind),
                if bytes.is_empty() { None } else { Some(bytes.as_mut_ptr()) },
                Some(&mut len),
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "could not read: {}\\{}", value.key, value.name);
        bytes.truncate(len as usize);
        (kind, bytes)
    }

    #[test]
    fn registry_writes_are_readable_idempotent_and_repair_one_value() {
        let root = TestRegistryRoot::new();
        let base = root.classes();
        assert!(!base.starts_with(PRODUCTION_BASE));
        let exe = Path::new("C:\\Users\\miyaz\\AppData\\Local\\mycmux\\mycmux.exe");
        let values = registration_values(&base, exe);
        assert_eq!(values.len(), 16);
        assert!(values.iter().all(|value| value.key.starts_with(&format!("{base}\\"))));

        assert!(register_under(&base, exe).unwrap());
        let expected: Vec<_> = values.iter().map(expected_bytes).collect();
        let original: Vec<_> = values.iter().map(read_registry_value).collect();
        assert_eq!(original, expected);
        assert!(!register_under(&base, exe).unwrap());

        let altered = &values[10];
        assert_eq!(altered.name, "FriendlyAppName");
        let path = wide(&altered.key);
        let name = wide(&altered.name);
        let mut raw = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), 0, KEY_SET_VALUE, &mut raw)
        };
        assert_eq!(status, ERROR_SUCCESS);
        let key = Key(raw);
        let tampered: Vec<u8> = wide("tampered").into_iter().flat_map(u16::to_le_bytes).collect();
        let status = unsafe {
            RegSetValueExW(key.0, PCWSTR(name.as_ptr()), 0, REG_SZ, Some(&tampered))
        };
        assert_eq!(status, ERROR_SUCCESS);
        drop(key);
        let changed: Vec<usize> = values.iter().enumerate()
            .filter_map(|(index, value)| (read_registry_value(value) != original[index]).then_some(index))
            .collect();
        assert_eq!(changed, vec![10]);

        assert!(register_under(&base, exe).unwrap());
        let repaired: Vec<_> = values.iter().map(read_registry_value).collect();
        assert_eq!(repaired, original);
    }

    #[test]
    fn exact_registry_plan_never_claims_defaults() {
        let exe = Path::new("C:\\Users\\miyaz\\AppData\\Local\\mycmux\\mycmux.exe");
        let values = registration_values(PRODUCTION_BASE, exe);
        let actual: Vec<String> = values
            .iter()
            .map(|item| {
                format!(
                    "HKCU\\{}|{}|{}|{}",
                    item.key,
                    item.name,
                    if item.empty { "REG_NONE" } else { "REG_SZ" },
                    item.value,
                )
            })
            .collect();
        for line in &actual {
            println!("{line}");
        }
        let command = "\"C:\\Users\\miyaz\\AppData\\Local\\mycmux\\mycmux.exe\" \"%1\"";
        let icon = "\"C:\\Users\\miyaz\\AppData\\Local\\mycmux\\mycmux.exe\",0";
        let expected = vec![
            "HKCU\\Software\\Classes\\mycmux.markdown||REG_SZ|Markdown (mycmux)".to_string(),
            format!("HKCU\\Software\\Classes\\mycmux.markdown\\DefaultIcon||REG_SZ|{icon}"),
            format!("HKCU\\Software\\Classes\\mycmux.markdown\\shell\\open\\command||REG_SZ|{command}"),
            "HKCU\\Software\\Classes\\mycmux.html||REG_SZ|HTML (mycmux)".to_string(),
            format!("HKCU\\Software\\Classes\\mycmux.html\\DefaultIcon||REG_SZ|{icon}"),
            format!("HKCU\\Software\\Classes\\mycmux.html\\shell\\open\\command||REG_SZ|{command}"),
            "HKCU\\Software\\Classes\\.md\\OpenWithProgids|mycmux.markdown|REG_NONE|".to_string(),
            "HKCU\\Software\\Classes\\.markdown\\OpenWithProgids|mycmux.markdown|REG_NONE|".to_string(),
            "HKCU\\Software\\Classes\\.html\\OpenWithProgids|mycmux.html|REG_NONE|".to_string(),
            "HKCU\\Software\\Classes\\.htm\\OpenWithProgids|mycmux.html|REG_NONE|".to_string(),
            "HKCU\\Software\\Classes\\Applications\\mycmux.exe|FriendlyAppName|REG_SZ|mycmux".to_string(),
            "HKCU\\Software\\Classes\\Applications\\mycmux.exe\\SupportedTypes|.md|REG_NONE|".to_string(),
            "HKCU\\Software\\Classes\\Applications\\mycmux.exe\\SupportedTypes|.markdown|REG_NONE|".to_string(),
            "HKCU\\Software\\Classes\\Applications\\mycmux.exe\\SupportedTypes|.html|REG_NONE|".to_string(),
            "HKCU\\Software\\Classes\\Applications\\mycmux.exe\\SupportedTypes|.htm|REG_NONE|".to_string(),
            format!("HKCU\\Software\\Classes\\Applications\\mycmux.exe\\shell\\open\\command||REG_SZ|{command}"),
        ];
        assert_eq!(actual, expected);
        assert!(values.iter().all(|item| !item.key.contains("UserChoice")));
        assert!(values
            .iter()
            .filter(|item| item.key.contains("\\OpenWithProgids"))
            .all(|item| !item.name.is_empty()));
        assert!(values.iter().all(|item| ![
            "Software\\Classes\\.md",
            "Software\\Classes\\.markdown",
            "Software\\Classes\\.html",
            "Software\\Classes\\.htm"
        ]
        .contains(&item.key.as_str())));
        assert_eq!(
            values[2].value,
            "\"C:\\Users\\miyaz\\AppData\\Local\\mycmux\\mycmux.exe\" \"%1\""
        );
    }

    #[test]
    fn only_installed_production_exe_can_register() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("mycmux.exe");
        assert!(!is_installed_release(false, None, &exe));
        std::fs::write(dir.path().join("uninstall.exe"), "").unwrap();
        assert!(is_installed_release(false, None, &exe));
        assert!(!is_installed_release(true, None, &exe));
        assert!(!is_installed_release(false, Some("test"), &exe));
    }
}
