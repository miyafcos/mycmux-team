//! Path normalization utilities shared across OSC 7, monitor, and session log.

/// Convert a POSIX-style Git-Bash drive path (e.g. `/c/Users/...`) to a
/// Windows-style path (`C:\Users\...`). Returns the input unchanged if it
/// does not match the drive-letter pattern.
pub fn posix_drive_to_windows(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b'/'
    {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let rest = path[2..].replace('/', "\\");
        format!("{drive}:{rest}")
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_lower_drive() {
        assert_eq!(posix_drive_to_windows("/c/Users/me"), "C:\\Users\\me");
    }

    #[test]
    fn converts_upper_drive() {
        assert_eq!(posix_drive_to_windows("/D/projects"), "D:\\projects");
    }

    #[test]
    fn leaves_posix_untouched() {
        assert_eq!(posix_drive_to_windows("/home/me"), "/home/me");
    }

    #[test]
    fn leaves_windows_untouched() {
        assert_eq!(posix_drive_to_windows("C:\\Users\\me"), "C:\\Users\\me");
    }

    #[test]
    fn leaves_short_inputs() {
        assert_eq!(posix_drive_to_windows("/"), "/");
        assert_eq!(posix_drive_to_windows(""), "");
    }

    #[test]
    fn ignores_non_letter_first_segment() {
        assert_eq!(posix_drive_to_windows("/1/foo"), "/1/foo");
    }
}
