use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
pub struct Track {
    pub path: String,
    pub filename: String,
    pub format: String,
    pub size_bytes: u64,
    pub modified_at: i64,
}

/// Walk the music root and collect playable tracks. We use HTML5 audio
/// for playback so we only enumerate file metadata here — no decoding.
/// `.ncm` is included even though current builds can't play it yet; the
/// Phase 5.B decrypt step will plug in.
pub fn scan(root: &Path) -> Vec<Track> {
    let mut tracks = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        let format = match ext.to_ascii_lowercase().as_str() {
            "mp3" => "mp3",
            "flac" => "flac",
            "wav" => "wav",
            "m4a" => "m4a",
            "ogg" => "ogg",
            "aac" => "aac",
            "ncm" => "ncm",
            _ => continue,
        };
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_at = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let filename = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        tracks.push(Track {
            path: path.to_string_lossy().to_string(),
            filename,
            format: format.to_string(),
            size_bytes,
            modified_at,
        });
    }
    // Sort by filename for predictable order
    tracks.sort_by(|a, b| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()));
    tracks
}
