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
#[tracing::instrument(skip(cache_dir), fields(src = %src.display()))]
pub fn decrypt_to_cache(src: &Path, cache_dir: &Path) -> Result<String, String> {
    if !src.exists() {
        return Err(format!("Source file not found: {}", src.display()));
    }
    fs::create_dir_all(cache_dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;

    let mtime = src
        .metadata()
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to stat: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let key = cache_key(src, mtime);

    // Probe known extensions before doing expensive decrypt
    for ext in ["mp3", "flac", "wav", "m4a", "ogg", "aac"] {
        let candidate = cache_dir.join(format!("{key}.{ext}"));
        if candidate.exists() {
            tracing::debug!(cached = %candidate.display(), "ncm cache hit");
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    // Cache miss: open + decrypt
    let file = fs::File::open(src).map_err(|e| format!("Failed to open NCM: {e}"))?;
    let mut ncm = Ncmdump::from_reader(file).map_err(|e| format!("NCM parse failed: {e}"))?;
    let info_format = match ncm.get_info() {
        Ok(info) => info.format,
        Err(e) => {
            // info 读不出来也不致命——magic byte 自己能定 format
            tracing::warn!(error = %e, "NCM info missing, will detect format by magic bytes");
            String::new()
        }
    };
    let data = ncm
        .get_data()
        .map_err(|e| format!("NCM decrypt failed: {e}"))?;
    if data.is_empty() {
        return Err("NCM decrypt produced 0 bytes".to_string());
    }

    // 修复: 不信任 ncm.get_info().format — 有些 NCM 文件 metadata 丢失或说谎
    // (例:一个 .ncm 实际是 flac 但 info.format = "mp3"), 落盘扩展名错配 →
    // HTML5 audio onError. 改用 magic byte 真检测.
    let detected = detect_audio_format(&data);
    let format = detected.unwrap_or(match info_format.to_ascii_lowercase().as_str() {
        "flac" => "flac",
        "wav" => "wav",
        "m4a" => "m4a",
        "ogg" => "ogg",
        "aac" => "aac",
        _ => "mp3",
    });
    tracing::info!(
        bytes = data.len(),
        info_format = %info_format,
        detected_format = ?detected,
        chosen_format = format,
        "NCM decrypt complete"
    );

    let out_path: PathBuf = cache_dir.join(format!("{key}.{format}"));
    fs::write(&out_path, data).map_err(|e| format!("Failed to write decrypted: {e}"))?;
    Ok(out_path.to_string_lossy().to_string())
}

/// 根据音频文件头 magic bytes 检测真实格式. 解密后的数据若类型已知,
/// 用真类型而非 ncm metadata 里声称的, 避免扩展名 / mime 错配.
fn detect_audio_format(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 {
        return None;
    }
    // FLAC: "fLaC"
    if &data[..4] == b"fLaC" {
        return Some("flac");
    }
    // OGG: "OggS"
    if &data[..4] == b"OggS" {
        return Some("ogg");
    }
    // WAV: "RIFF....WAVE"
    if &data[..4] == b"RIFF" && &data[8..12] == b"WAVE" {
        return Some("wav");
    }
    // M4A / MP4: bytes 4..8 = "ftyp"
    if &data[4..8] == b"ftyp" {
        return Some("m4a");
    }
    // MP3: ID3v2 ("ID3") 或者 frame sync (0xFF 0xE0..0xFF)
    if &data[..3] == b"ID3" {
        return Some("mp3");
    }
    if data[0] == 0xFF && (data[1] & 0xE0) == 0xE0 {
        return Some("mp3");
    }
    // AAC ADTS: 0xFF 0xF0..0xFF (12 bit sync + layer)
    if data[0] == 0xFF && (data[1] & 0xF0) == 0xF0 {
        return Some("aac");
    }
    None
}

fn cache_key(src: &Path, mtime: u64) -> String {
    let mut hasher = DefaultHasher::new();
    src.to_string_lossy().as_bytes().hash(&mut hasher);
    mtime.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_flac() {
        let mut buf = b"fLaC".to_vec();
        buf.extend_from_slice(&[0u8; 20]);
        assert_eq!(detect_audio_format(&buf), Some("flac"));
    }

    #[test]
    fn detect_mp3_id3() {
        let mut buf = b"ID3".to_vec();
        buf.extend_from_slice(&[0u8; 20]);
        assert_eq!(detect_audio_format(&buf), Some("mp3"));
    }

    #[test]
    fn detect_mp3_sync_byte() {
        let buf = vec![0xFFu8, 0xFB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(detect_audio_format(&buf), Some("mp3"));
    }

    #[test]
    fn detect_m4a() {
        let buf = vec![0u8, 0, 0, 0x20, b'f', b't', b'y', b'p', 0, 0, 0, 0];
        assert_eq!(detect_audio_format(&buf), Some("m4a"));
    }

    #[test]
    fn detect_wav() {
        let buf = vec![b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'W', b'A', b'V', b'E'];
        assert_eq!(detect_audio_format(&buf), Some("wav"));
    }

    #[test]
    fn detect_returns_none_for_garbage() {
        let buf = vec![0u8; 100];
        assert_eq!(detect_audio_format(&buf), None);
    }
}
