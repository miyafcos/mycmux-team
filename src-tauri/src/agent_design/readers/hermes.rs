use super::*;
pub fn read(root: &Path) -> Scan {
    let mut scan = Scan::new("hermes", "Hermes", root);
    for (path, layer, kind, timing) in [
        ("config.yaml", 2, "settings", "outside"),
        ("SOUL.md", 3, "instruction", "always"),
        ("memories", 4, "memoryDirectory", "onDemand"),
        ("cron", 6, "cron", "schedule"),
    ] {
        scan.item(layer, &root.join(path), kind, timing, false, false);
    }
    let skills = safe::files(&root.join("skills"), Some(&["md"])).map(|v| {
        v.into_iter()
            .filter(|p| safe::basename(p) == "SKILL.md")
            .collect::<Vec<_>>()
    });
    scan.service
        .stat("skillsOwn", skills.as_ref().map(|v| v.len() as u64));
    if let Some(paths) = skills {
        for path in paths {
            scan.item(5, &path, "skill", "onDemand", false, false);
        }
    }
    scan
}
