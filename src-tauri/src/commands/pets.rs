use base64::Engine as _;
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_ATLAS_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AtlasSpec {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) cols: u8,
    pub(crate) rows: u8,
}

pub(crate) fn validate_atlas(width: u32, height: u32) -> Result<AtlasSpec, String> {
    if width != 1536 {
        return Err(format!("Atlas width must be 1536px, got {width}px"));
    }
    if height % 208 != 0 {
        return Err(format!("Atlas height must be divisible by 208px, got {height}px"));
    }
    let rows = height / 208;
    if !(9..=11).contains(&rows) {
        return Err(format!("Atlas must contain 9 to 11 rows, got {rows}"));
    }
    Ok(AtlasSpec { width, height, cols: 8, rows: rows as u8 })
}

#[derive(Serialize, Clone)]
pub struct PetInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) source: String,
    pub(crate) atlas_b64: Option<String>,
    pub(crate) atlas_width: Option<u32>,
    pub(crate) atlas_height: Option<u32>,
    pub(crate) rows: Option<u8>,
    pub(crate) valid: bool,
    pub(crate) warning: Option<String>,
    pub(crate) folder: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct PetManifest {
    #[serde(alias = "displayName")]
    pub(crate) name: Option<String>,
}

pub(crate) fn pet_info_from_directory(folder: String, directory: &Path) -> PetInfo {
    let name = fs::read_to_string(directory.join("pet.json"))
        .ok()
        .and_then(|contents| serde_json::from_str::<PetManifest>(&contents).ok())
        .and_then(|manifest| manifest.name)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| folder.clone());
    let atlas = ["spritesheet.webp", "spritesheet.png"]
        .into_iter()
        .map(|file_name| directory.join(file_name))
        .find(|path| path.is_file());

    let Some(atlas) = atlas else {
        return invalid_pet(folder, name, "Missing spritesheet.webp or spritesheet.png".to_string());
    };
    let dimensions = match imagesize::size(&atlas) {
        Ok(size) => (size.width as u32, size.height as u32),
        Err(error) => return invalid_pet(folder, name, format!("Could not read atlas dimensions: {error}")),
    };
    let spec = match validate_atlas(dimensions.0, dimensions.1) {
        Ok(spec) => spec,
        Err(error) => return invalid_pet_with_dimensions(folder, name, dimensions, error),
    };
    let metadata = match fs::metadata(&atlas) {
        Ok(metadata) => metadata,
        Err(error) => return invalid_pet_with_dimensions(folder, name, dimensions, format!("Could not read atlas metadata: {error}")),
    };
    if metadata.len() > MAX_ATLAS_BYTES {
        return invalid_pet_with_dimensions(
            folder,
            name,
            dimensions,
            format!("Atlas exceeds the {} MiB IPC limit", MAX_ATLAS_BYTES / 1024 / 1024),
        );
    }
    let bytes = match fs::read(&atlas) {
        Ok(bytes) => bytes,
        Err(error) => return invalid_pet_with_dimensions(folder, name, dimensions, format!("Could not read atlas: {error}")),
    };
    PetInfo {
        id: format!("external:{folder}"),
        name,
        source: "external".to_string(),
        atlas_b64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        atlas_width: Some(spec.width),
        atlas_height: Some(spec.height),
        rows: Some(spec.rows),
        valid: true,
        warning: None,
        folder,
    }
}

fn invalid_pet(folder: String, name: String, warning: String) -> PetInfo {
    invalid_pet_with_dimensions(folder, name, (0, 0), warning)
}

fn invalid_pet_with_dimensions(folder: String, name: String, dimensions: (u32, u32), warning: String) -> PetInfo {
    PetInfo {
        id: format!("external:{folder}"),
        name,
        source: "external".to_string(),
        atlas_b64: None,
        atlas_width: (dimensions.0 != 0).then_some(dimensions.0),
        atlas_height: (dimensions.1 != 0).then_some(dimensions.1),
        rows: None,
        valid: false,
        warning: Some(warning),
        folder,
    }
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
            if folder.starts_with('_') {
                return None;
            }
            Some(pet_info_from_directory(folder, &entry.path()))
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
        atlas_width: Some(1536),
        atlas_height: Some(1872),
        rows: Some(9),
        valid: true,
        warning: None,
        folder: "clawd".to_string(),
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

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn validate_atlas_accepts_both_supported_formats() {
        assert_eq!(validate_atlas(1536, 1872).unwrap().rows, 9);
        assert_eq!(validate_atlas(1536, 2288).unwrap().rows, 11);
    }

    #[test]
    fn validate_atlas_rejects_nonstandard_dimensions() {
        assert!(validate_atlas(2504, 1878).is_err());
        assert!(validate_atlas(1252, 939).is_err());
        assert!(validate_atlas(1535, 1872).is_err());
    }

    #[test]
    fn external_pets_reads_manifest_name_and_png_atlas() {
        let root = tempfile::tempdir().unwrap();
        let pet_dir = root.path().join("sample");
        fs::create_dir(&pet_dir).unwrap();
        fs::write(pet_dir.join("spritesheet.png"), png_header(1536, 1872)).unwrap();
        fs::write(pet_dir.join("pet.json"), r#"{"displayName":"Sample"}"#).unwrap();

        let pets = external_pets(root.path());
        assert_eq!(pets.len(), 1);
        assert_eq!(pets[0].id, "external:sample");
        assert_eq!(pets[0].name, "Sample");
        assert_eq!(pets[0].source, "external");
        assert!(pets[0].atlas_b64.is_some());
        assert_eq!(pets[0].rows, Some(9));
        assert!(pets[0].valid);
    }

    #[test]
    fn external_pets_skips_quarantined_folders() {
        let root = tempfile::tempdir().unwrap();
        let disabled = root.path().join("_disabled");
        let pet_dir = root.path().join("sample");
        fs::create_dir(&disabled).unwrap();
        fs::create_dir(&pet_dir).unwrap();
        fs::write(pet_dir.join("spritesheet.png"), png_header(1536, 1872)).unwrap();

        let pets = external_pets(root.path());
        assert_eq!(pets.len(), 1);
        assert_eq!(pets[0].folder, "sample");
    }

    #[test]
    fn manifest_accepts_display_name_alias() {
        let manifest: PetManifest = serde_json::from_str(r#"{"displayName":"Gallery pet"}"#).unwrap();
        assert_eq!(manifest.name.as_deref(), Some("Gallery pet"));
    }
}
