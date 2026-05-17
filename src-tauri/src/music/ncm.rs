//! NCM decryption + on-disk cache. We never modify the source `.ncm`;
//! decrypted output lives at `{app_data_dir}/music_cache/{hash}.{ext}`
//! so subsequent plays hit the cache instantly.

use ncmdump::Ncmdump;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// Decrypt an `.ncm` file at `src` into `cache_dir`. Returns the absolute
/// path of the decrypted file. Re-uses the existing cached file if the
/// source path + mtime match what we cached previously.
pub fn decrypt_to_cache(src: &Path, cache_dir: &Path) -> Result<String, String> {
    if !src.exists() {
        return Err(format!("Source file not found: {}", src.display()));
    }
    fs::create_dir_all(cache_dir)
        .map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let mtime = src
        .metadata()
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to stat: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let key = cache_key(src, mtime);

    // Probe both possible extensions before doing expensive decrypt
    for ext in ["mp3", "flac"] {
        let candidate = cache_dir.join(format!("{key}.{ext}"));
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    // Cache miss: open + decrypt
    let file = fs::File::open(src).map_err(|e| format!("Failed to open NCM: {e}"))?;
    let mut ncm = Ncmdump::from_reader(file).map_err(|e| format!("NCM parse failed: {e}"))?;
    let info = ncm
        .get_info()
        .map_err(|e| format!("NCM info read failed: {e}"))?;
    let data = ncm
        .get_data()
        .map_err(|e| format!("NCM decrypt failed: {e}"))?;

    let format = if info.format.is_empty() {
        "mp3".to_string()
    } else {
        info.format
    };
    let out_path: PathBuf = cache_dir.join(format!("{key}.{format}"));
    fs::write(&out_path, data).map_err(|e| format!("Failed to write decrypted: {e}"))?;
    Ok(out_path.to_string_lossy().to_string())
}

fn cache_key(src: &Path, mtime: u64) -> String {
    let mut hasher = DefaultHasher::new();
    src.to_string_lossy().as_bytes().hash(&mut hasher);
    mtime.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
