use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_ATLAS_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
pub struct PetInfo {
    id: String,
    name: String,
    source: String,
    atlas_b64: Option<String>,
}

#[derive(serde::Deserialize)]
struct PetManifest {
    name: Option<String>,
}

fn external_pets(root: &Path) -> Vec<PetInfo> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_dir() {
                return None;
            }
            let folder = entry.file_name().to_string_lossy().into_owned();
            let directory = entry.path();
            let atlas = ["spritesheet.webp", "spritesheet.png"]
                .into_iter()
                .map(|name| directory.join(name))
                .find(|path| path.is_file())?;
            let metadata = fs::metadata(&atlas).ok()?;
            if metadata.len() > MAX_ATLAS_BYTES {
                eprintln!("[pets] Skipping oversized atlas: {}", atlas.display());
                return None;
            }
            let bytes = fs::read(&atlas).ok()?;
            let name = fs::read_to_string(directory.join("pet.json"))
                .ok()
                .and_then(|contents| serde_json::from_str::<PetManifest>(&contents).ok())
                .and_then(|manifest| manifest.name)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| folder.clone());
            Some(PetInfo {
                id: format!("external:{folder}"),
                name,
                source: "external".to_string(),
                atlas_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            })
        })
        .collect()
}

#[tauri::command(async)]
pub async fn list_pets() -> Result<Vec<PetInfo>, String> {
    let mut pets = vec![PetInfo {
        id: "clawd".to_string(),
        name: "Clawd".to_string(),
        source: "bundled".to_string(),
        atlas_b64: None,
    }];
    let Some(home) = dirs::home_dir() else {
        return Ok(pets);
    };
    pets.extend(external_pets(&home.join(".codex").join("pets")));
    Ok(pets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_pets_reads_manifest_name_and_png_atlas() {
        let root = tempfile::tempdir().unwrap();
        let pet_dir = root.path().join("sample");
        fs::create_dir(&pet_dir).unwrap();
        fs::write(pet_dir.join("spritesheet.png"), [1_u8, 2, 3]).unwrap();
        fs::write(pet_dir.join("pet.json"), r#"{"name":"Sample"}"#).unwrap();

        let pets = external_pets(root.path());
        assert_eq!(pets.len(), 1);
        assert_eq!(pets[0].id, "external:sample");
        assert_eq!(pets[0].name, "Sample");
        assert_eq!(pets[0].source, "external");
        assert_eq!(pets[0].atlas_b64.as_deref(), Some("AQID"));
    }
}
