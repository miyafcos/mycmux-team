// The previous Windows flash suppression mechanisms caused sustained CPU burn.
// Keep these hooks disabled until we have a descendant-scoped implementation.
pub fn start_startup_flash_suppression(_root_pid: u32) {}

pub fn suppress_spawn_flash(_root_pid: u32) {}
