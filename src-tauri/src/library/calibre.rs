//! C8 — Calibre 库直连导入。
//!
//! Calibre 的 `metadata.db` 是 SQLite，文件组织为
//! `<library_root>/<author>/<title> (id)/<title> - <author>.epub` 形式，
//! 封面是同目录下的 `cover.jpg`。
//!
//! 用 SQLite 读 metadata.db 拿元数据 + 落盘文件路径，然后转写到我们自己的
//! `books` 表 (复用 `db::upsert_book`)。**只读 Calibre 数据库**——用
//! `OpenFlags::SQLITE_OPEN_READ_ONLY` 保证不会写坏用户的 Calibre 库
//! (CLAUDE.md 原则 14 冗余兜底:不破坏外部系统)。
//!
//! 多 format 的书 (常见: 一本 EPUB + 一本 PDF + 一本 MOBI)，按下面优先级
//! 选一个我们能渲染的：epub > pdf > mobi > azw3 > azw > docx > txt。

use crate::db::{upsert_book, Book};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct CalibreLibraryInfo {
    pub root: String,
    pub book_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalibreImportReport {
    pub scanned: usize,
    pub imported: usize,
    pub skipped_no_format: usize,
    pub skipped_missing_file: usize,
}

/// 检查给定目录是不是合法 Calibre 库（含 metadata.db 且 books 表有行）。
pub fn detect_calibre_library(path: &Path) -> Option<CalibreLibraryInfo> {
    let db_path = path.join("metadata.db");
    if !db_path.exists() {
        return None;
    }
    let conn = match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(c) => c,
        Err(_) => return None,
    };
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM books", [], |row| row.get(0))
        .ok()?;
    Some(CalibreLibraryInfo {
        root: path.to_string_lossy().to_string(),
        book_count: count,
    })
}

/// 按 format 优先级排序，越靠前的越优先。其他 / 未知格式 → 跳过。
fn format_priority(fmt: &str) -> Option<u32> {
    match fmt.to_ascii_lowercase().as_str() {
        "epub" => Some(0),
        "pdf" => Some(1),
        "mobi" => Some(2),
        "azw3" => Some(3),
        "azw" => Some(4),
        "docx" => Some(5),
        "txt" => Some(6),
        _ => None,
    }
}

/// 把 Calibre 库导进 AIreader 的 books 表。
///
/// 每本书：取 Calibre 自己存的标题 / 作者 / 相对路径，选优先级最高的格式
/// 文件，拼绝对路径后调 `db::upsert_book` 写。封面有就直接挂 cover_path。
pub fn import_calibre_library(
    target_conn: &Connection,
    calibre_root: &Path,
) -> Result<CalibreImportReport, String> {
    let metadata_db = calibre_root.join("metadata.db");
    let src = Connection::open_with_flags(&metadata_db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法打开 Calibre metadata.db: {e}"))?;

    // 一条 query 把所有 book + format 都拉出来。后续按 book_id 聚合选最佳 format。
    let mut stmt = src
        .prepare(
            "SELECT b.id, b.title, b.author_sort, b.path, d.format, d.name
             FROM books b
             LEFT JOIN data d ON d.book = b.id
             ORDER BY b.id, d.format",
        )
        .map_err(|e| format!("查询 Calibre books 失败: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(CalibreRow {
                book_id: row.get(0)?,
                title: row.get(1)?,
                author_sort: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                path: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                format: row.get::<_, Option<String>>(4)?,
                name: row.get::<_, Option<String>>(5)?,
            })
        })
        .map_err(|e| format!("迭代 Calibre books 失败: {e}"))?;

    // 按 book_id 聚合
    let mut by_book: std::collections::BTreeMap<i64, Vec<CalibreRow>> =
        std::collections::BTreeMap::new();
    for r in rows {
        match r {
            Ok(row) => by_book.entry(row.book_id).or_default().push(row),
            Err(_) => continue,
        }
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let mut report = CalibreImportReport {
        scanned: by_book.len(),
        imported: 0,
        skipped_no_format: 0,
        skipped_missing_file: 0,
    };

    for (_, rows) in by_book {
        let Some(chosen) = parse_best_row(&rows) else {
            report.skipped_no_format += 1;
            continue;
        };

        // Calibre 文件名: <name>.<format-lower>
        let format = chosen
            .format
            .as_deref()
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let name = chosen.name.clone().unwrap_or_default();
        if name.is_empty() {
            report.skipped_no_format += 1;
            continue;
        }
        let file_rel = format!("{}/{}.{}", chosen.path, name, format);
        let file_abs: PathBuf = calibre_root.join(&file_rel);
        if !file_abs.exists() {
            report.skipped_missing_file += 1;
            continue;
        }

        let (file_size, file_modified) = std::fs::metadata(&file_abs)
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

        // Calibre 封面: <library_root>/<path>/cover.jpg
        let cover_abs = calibre_root.join(&chosen.path).join("cover.jpg");
        let cover_path = if cover_abs.exists() {
            Some(cover_abs.to_string_lossy().to_string())
        } else {
            None
        };

        let book = Book {
            id: 0,
            file_path: file_abs.to_string_lossy().to_string(),
            format: format.clone(),
            title: chosen.title.clone(),
            author: if chosen.author_sort.is_empty() {
                "Unknown".to_string()
            } else {
                chosen.author_sort.clone()
            },
            added_at: now_ms,
            file_size,
            file_modified,
            category: String::new(),
            last_read_at: None,
            cover_path: cover_path.clone(),
            read_time_ms: 0,
        };

        if upsert_book(target_conn, &book).is_ok() {
            // upsert_book 不写 cover_path（schema 老版本兼容），单独写
            if let Some(cp) = &cover_path {
                let _ = crate::db::set_book_cover_by_path(target_conn, &book.file_path, cp);
            }
            report.imported += 1;
        }
    }

    Ok(report)
}

#[derive(Debug, Clone)]
struct CalibreRow {
    book_id: i64,
    title: String,
    author_sort: String,
    path: String,
    format: Option<String>,
    name: Option<String>,
}

/// 在同一本书的多个 format 行里选优先级最高的（epub > pdf > mobi > ...）。
fn parse_best_row(rows: &[CalibreRow]) -> Option<&CalibreRow> {
    rows.iter()
        .filter(|r| r.format.is_some() && r.name.is_some())
        .filter(|r| {
            r.format
                .as_deref()
                .and_then(format_priority)
                .is_some()
        })
        .min_by_key(|r| {
            r.format
                .as_deref()
                .and_then(format_priority)
                .unwrap_or(u32::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(book_id: i64, format: &str, name: &str) -> CalibreRow {
        CalibreRow {
            book_id,
            title: "T".into(),
            author_sort: "A".into(),
            path: "P".into(),
            format: Some(format.into()),
            name: Some(name.into()),
        }
    }

    #[test]
    fn parse_best_prefers_epub_over_pdf() {
        let rows = vec![
            row(1, "PDF", "x"),
            row(1, "EPUB", "x"),
            row(1, "MOBI", "x"),
        ];
        let best = parse_best_row(&rows).unwrap();
        assert_eq!(best.format.as_deref(), Some("EPUB"));
    }

    #[test]
    fn parse_best_drops_unknown_format() {
        let rows = vec![row(1, "RAR", "x")]; // unsupported → no winner
        assert!(parse_best_row(&rows).is_none());
    }

    #[test]
    fn parse_best_fallback_to_lowest_priority_when_only_one_supported() {
        let rows = vec![row(1, "DJVU", "x"), row(1, "TXT", "x")];
        let best = parse_best_row(&rows).unwrap();
        assert_eq!(best.format.as_deref(), Some("TXT"));
    }

    #[test]
    fn format_priority_recognizes_all_supported() {
        for fmt in &["epub", "pdf", "mobi", "azw3", "azw", "docx", "txt"] {
            assert!(format_priority(fmt).is_some(), "should know {fmt}");
        }
        assert!(format_priority("djvu").is_none());
        assert!(format_priority("").is_none());
    }
}
