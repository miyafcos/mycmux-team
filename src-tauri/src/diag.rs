use chrono::Local;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

const MAX_LOG_BYTES: u64 = 1024 * 1024;
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn log(line: &str) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = log_to_home(&home, line);
}

fn log_to_home(home: &Path, line: &str) -> io::Result<()> {
    let dir = home.join(".mycmux");
    fs::create_dir_all(&dir)?;

    let path = dir.join("diag.log");
    let rotated = dir.join("diag.log.1");
    if fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::remove_file(&rotated);
        fs::rename(&path, &rotated)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{} {line}", Local::now().format("%Y-%m-%dT%H:%M:%S%:z"))
}

#[cfg(test)]
mod tests {
    use super::{log_to_home, MAX_LOG_BYTES};
    use std::fs;

    #[test]
    fn rotates_an_oversized_log_without_touching_the_real_home() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(".mycmux");
        fs::create_dir_all(&dir).unwrap();
        let old_log = vec![b'a'; (MAX_LOG_BYTES + 1) as usize];
        fs::write(dir.join("diag.log"), &old_log).unwrap();
        fs::write(dir.join("diag.log.1"), b"older generation").unwrap();

        log_to_home(temp.path(), "fresh diagnostic").unwrap();

        assert_eq!(fs::read(dir.join("diag.log.1")).unwrap(), old_log);
        let fresh = fs::read_to_string(dir.join("diag.log")).unwrap();
        assert!(fresh.ends_with("fresh diagnostic\n"));
    }
}
