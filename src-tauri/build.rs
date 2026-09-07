use std::{env, fs, path::Path};
#[allow(dead_code)]
#[path = "src/claude_skills/pack_rules.rs"]
mod pack_rules;

fn scan(root: &Path, dir: &Path, files: &mut Vec<(String, std::path::PathBuf)>) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut entries: Vec<_> = fs::read_dir(dir)
        .expect("read Claude pack")
        .map(Result::unwrap)
        .collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        if pack_rules::excluded_part(&name.to_string_lossy()) {
            continue;
        }
        let kind = entry.file_type().expect("pack file type");
        assert!(
            !kind.is_symlink(),
            "symlink in Claude pack: {}",
            path.display()
        );
        if kind.is_dir() {
            scan(root, &path, files);
        } else if kind.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            files.push((
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                path,
            ));
        }
    }
}
fn main() {
    let root = Path::new("../skills/claude")
        .canonicalize()
        .expect("Claude pack");
    let mut files = Vec::new();
    scan(&root, &root, &mut files);
    // Top-level README is documentation, not a manifest-managed payload.
    files.retain(|(rel, _)| rel != "README.md");
    let cli = Path::new("../scripts/mycmux_agent_cli.py")
        .canonicalize()
        .expect("agent CLI");
    println!("cargo:rerun-if-changed={}", cli.display());
    println!("cargo:rerun-if-changed=src/claude_skills/pack_rules.rs");
    let mut code = String::from("pub static PACK_FILES: &[(&str, &[u8])] = &[\n");
    for (rel, path) in files {
        code.push_str(&format!(
            "    ({rel:?}, include_bytes!({:?})),\n",
            path.to_str().unwrap()
        ));
    }
    code.push_str(&format!(
        "];\npub static PACK_CLI: &[u8] = include_bytes!({:?});\n",
        cli.to_str().unwrap()
    ));
    code.push_str(&format!(
        "pub static PACK_MANIFEST: &[u8] = include_bytes!({:?});\n",
        root.join("manifest.json").to_str().unwrap()
    ));
    fs::write(
        Path::new(&env::var_os("OUT_DIR").unwrap()).join("claude_skills_pack.rs"),
        code,
    )
    .expect("embed Claude pack");
    tauri_build::build()
}
