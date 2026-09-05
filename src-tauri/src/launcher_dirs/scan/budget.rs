use std::time::{Duration, Instant};

pub const MAX_DIRECTORIES: usize = 50_000;
pub const MAX_SECONDS: u64 = 30;

pub struct Budget {
    pub deadline: Instant,
    pub visited: usize,
    pub truncated: bool,
}

impl Budget {
    pub fn new() -> Self {
        Self {
            deadline: Instant::now() + Duration::from_secs(MAX_SECONDS),
            visited: 0,
            truncated: false,
        }
    }

    pub fn check(&mut self) -> bool {
        if Instant::now() >= self.deadline {
            self.truncated = true;
        }
        !self.truncated
    }

    pub fn visit(&mut self) -> bool {
        if self.visited >= MAX_DIRECTORIES {
            self.truncated = true;
        }
        if !self.check() {
            return false;
        }
        self.visited += 1;
        true
    }
}
