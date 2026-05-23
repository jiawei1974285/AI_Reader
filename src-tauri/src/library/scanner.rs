use crate::db::{set_book_cover_by_path, upsert_book, Book};
use crate::readers::epub::{
    extract_cover as extract_epub_cover, extract_metadata as extract_epub_metadata,
};
use crate::readers::mobi::extract_metadata as extract_mobi_metadata;
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanReport {
    pub scanned: usize,
    pub added_or_updated: usize,
    pub removed: usize,
}

pub fn scan(
    conn: &Connection,
    root: &Path,
    covers_dir: Option<&Path>,
) -> Result<ScanReport, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let mut scanned = 0usize;
    let mut upserted = 0usize;
    let mut visited: HashSet<String> = HashSet::new();

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

        let Some(format) = format_for_extension(ext) else {
            continue;
        };

        // Get file metadata once (need size for filtering anyway)
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        if !looks_like_a_book(path, format, size) {
            continue;
        }

        scanned += 1;
        let file_path = path.to_string_lossy().to_string();
        visited.insert(file_path.clone());

        let (file_size, file_modified) = entry
            .metadata()
            .ok()
            .map(|m| {
                let size = m.len() as i64;
                let modified = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                (size, modified)
            })
            .unwrap_or((0, 0));

        let (title, author) = match format {
            "epub" => extract_epub_metadata(path)
                .unwrap_or_else(|_| (file_stem_or(path, "Untitled"), "Unknown".to_string())),
            "mobi" | "azw" | "azw3" => extract_mobi_metadata(path)
                .unwrap_or_else(|_| (file_stem_or(path, "Untitled"), "Unknown".to_string())),
            _ => (file_stem_or(path, "Untitled"), "Unknown".to_string()),
        };

        let book = Book {
            id: 0,
            file_path,
            format: format.to_string(),
            title,
            author,
            added_at: now_ms,
            file_size,
            file_modified,
            category: String::new(),
            last_read_at: None,
            cover_path: None,
            read_time_ms: 0,
        };

        let path_for_cover = book.file_path.clone();
        if upsert_book(conn, &book).is_ok() {
            upserted += 1;
        }

        // Try to extract + cache an EPUB cover, then record its path in
        // the DB. Skipped for non-EPUB formats and silently no-op if the
        // book has no cover or we already cached one.
        if format == "epub" {
            if let Some(dir) = covers_dir {
                if let Err(_e) = maybe_cache_epub_cover(conn, &path_for_cover, dir) {
                    // Cover extraction failures are non-fatal — book stays
                    // in DB with no cover_path.
                }
            }
        }
    }

    // Sync: any book in the DB whose path we did NOT visit this scan is no
    // longer in the current library (either the user changed the root or
    // the file was deleted/moved). Remove them. CASCADE handles their
    // reading progress and highlights.
    let removed = prune_missing_books(conn, &visited).map_err(|e| e.to_string())?;

    Ok(ScanReport {
        scanned,
        added_or_updated: upserted,
        removed,
    })
}

fn prune_missing_books(conn: &Connection, visited: &HashSet<String>) -> rusqlite::Result<usize> {
    let mut existing: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT file_path FROM books")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for r in rows {
            existing.push(r?);
        }
    }
    let mut removed = 0usize;
    for path in existing {
        if !visited.contains(&path) {
            conn.execute("DELETE FROM books WHERE file_path = ?1", params![path])?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn format_for_extension(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "epub" => Some("epub"),
        "txt" => Some("txt"),
        "pdf" => Some("pdf"),
        "docx" => Some("docx"),
        "mobi" => Some("mobi"),
        "azw" => Some("azw"),
        "azw3" => Some("azw3"),
        _ => None,
    }
}

fn maybe_cache_epub_cover(
    conn: &Connection,
    book_file_path: &str,
    covers_dir: &Path,
) -> Result<(), String> {
    // Skip if we already have a cached cover for this book
    if let Ok(Some(existing)) = crate::db::get_book_cover_path(conn, book_file_path) {
        if Path::new(&existing).exists() {
            return Ok(());
        }
    }

    let book_path = Path::new(book_file_path);
    let Some((bytes, mime)) = extract_epub_cover(book_path) else {
        return Ok(());
    };

    let ext = match mime.as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };

    std::fs::create_dir_all(covers_dir).map_err(|e| e.to_string())?;

    // Use a hash of the book path as the filename so re-scans hit the
    // same key. Avoids needing the book's DB id (which would require an
    // extra SELECT round-trip).
    let hash = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        book_file_path.hash(&mut h);
        format!("{:016x}", h.finish())
    };
    let cover_path: PathBuf = covers_dir.join(format!("{hash}.{ext}"));
    std::fs::write(&cover_path, &bytes).map_err(|e| e.to_string())?;
    set_book_cover_by_path(conn, book_file_path, &cover_path.to_string_lossy())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn file_stem_or(path: &Path, fallback: &str) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(fallback)
        .to_string()
}

/// Heuristic filter to drop non-book files (READMEs, install manuals,
/// hidden files, OS-system folders) from the scan. We optimise for
/// "false-negative is fine, false-positive is bad": we'd rather show
/// one extra README than hide a real book.
fn looks_like_a_book(path: &Path, format: &str, size: u64) -> bool {
    // System / hidden / metadata folders
    for comp in path.components() {
        if let Some(s) = comp.as_os_str().to_str() {
            if s.starts_with('.') && s != "." && s != ".." {
                return false;
            }
            if matches!(s, "__MACOSX" | "$RECYCLE.BIN" | "System Volume Information") {
                return false;
            }
        }
    }

    // Size floor by format. Real books are very rarely tinier than this.
    let min_size: u64 = match format {
        "txt" => 3 * 1024, // 3 KB
        "epub" | "docx" | "mobi" | "azw" | "azw3" => 10 * 1024,
        "pdf" => 30 * 1024,
        _ => 0,
    };
    if size < min_size {
        return false;
    }

    // Filename blacklist (case-insensitive, with separator-aware prefix match)
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    const NONBOOK: &[&str] = &[
        "readme",
        "license",
        "licence",
        "copyright",
        "changelog",
        "changes",
        "release notes",
        "manual",
        "install",
        "setup",
        "usage",
        "instructions",
        "说明",
        "使用说明",
        "用户手册",
        "用户指南",
        "安装",
        "安装说明",
        "授权",
        "版权",
        "免责声明",
    ];
    for pat in NONBOOK {
        if stem == *pat {
            return false;
        }
        for sep in [' ', '-', '_', '.'] {
            if stem.starts_with(&format!("{pat}{sep}")) {
                return false;
            }
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_for_extension_keeps_azw_distinct_from_mobi() {
        assert_eq!(format_for_extension("mobi"), Some("mobi"));
        assert_eq!(format_for_extension("azw"), Some("azw"));
        assert_eq!(format_for_extension("azw3"), Some("azw3"));
    }
}
