//! Per-book indexing pipeline: extract chapter text → chunk → embed →
//! store. Designed to run from a `spawn_blocking` task because both the
//! file parsing and the embedding are CPU-bound.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::ai::{chunker, embed};
use crate::db;

#[derive(Debug, Clone)]
pub struct ChapterText {
    pub spine_index: usize,
    pub text: String,
}

/// Extract plain text per chapter/page for any supported format.
pub fn extract_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "epub" => extract_epub_chapters(path),
        "txt" => extract_txt_chapters(path),
        "docx" => extract_docx_chapters(path),
        "mobi" | "azw" | "azw3" => extract_mobi_chapters(path),
        "pdf" => extract_pdf_pages(path),
        other => Err(format!("Unsupported format for indexing: {other}")),
    }
}

fn extract_epub_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    use ::epub::doc::EpubDoc;
    let mut doc = EpubDoc::new(path).map_err(|e| format!("Failed to open EPUB: {e}"))?;
    let nav_id = doc.get_nav_id();
    let spine = doc.spine.clone();
    let mut chapters = Vec::new();
    for (idx, item) in spine.iter().enumerate() {
        if nav_id.as_deref() == Some(item.idref.as_str()) {
            continue;
        }
        let Some((content, _mime)) = doc.get_resource_str(&item.idref) else {
            continue;
        };
        let text = strip_html_to_text(&content);
        let trimmed = text.trim();
        if trimmed.chars().count() < 30 {
            continue;
        }
        chapters.push(ChapterText {
            spine_index: idx,
            text: trimmed.to_string(),
        });
    }
    Ok(chapters)
}

fn extract_txt_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    let text = crate::readers::txt::read_and_decode(path)?;
    let chapters = crate::readers::txt::split_into_chapters(&text);
    Ok(chapters
        .into_iter()
        .enumerate()
        .map(|(idx, ch)| ChapterText {
            spine_index: idx,
            text: ch.content,
        })
        .collect())
}

fn extract_docx_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    use docx_rs::*;
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read DOCX: {e}"))?;
    let docx = read_docx(&bytes).map_err(|e| format!("Failed to parse DOCX: {e:?}"))?;
    let mut text = String::new();
    for child in &docx.document.children {
        if let DocumentChild::Paragraph(p) = child {
            for child in &p.children {
                if let ParagraphChild::Run(r) = child {
                    for rc in &r.children {
                        if let RunChild::Text(t) = rc {
                            text.push_str(&t.text);
                        }
                    }
                }
            }
            text.push('\n');
        }
    }
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![ChapterText {
        spine_index: 0,
        text,
    }])
}

fn extract_mobi_chapters(path: &Path) -> Result<Vec<ChapterText>, String> {
    Ok(crate::readers::mobi::extract_text_chapters(path)?
        .into_iter()
        .map(|(idx, text)| ChapterText {
            spine_index: idx,
            text,
        })
        .collect())
}

fn extract_pdf_pages(path: &Path) -> Result<Vec<ChapterText>, String> {
    let pages = crate::readers::pdf::extract_pages(path)?;
    Ok(pages
        .into_iter()
        .enumerate()
        .map(|(idx, text)| ChapterText {
            spine_index: idx,
            text: text.trim().to_string(),
        })
        .filter(|ch| ch.text.chars().filter(|c| !c.is_whitespace()).count() >= 20)
        .collect())
}

fn strip_html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut prev_was_space = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
            }
            '>' => {
                in_tag = false;
                if !prev_was_space {
                    out.push(' ');
                    prev_was_space = true;
                }
            }
            _ if in_tag => {}
            _ => {
                if c.is_whitespace() {
                    if !prev_was_space {
                        out.push(' ');
                        prev_was_space = true;
                    }
                } else {
                    out.push(c);
                    prev_was_space = false;
                }
            }
        }
    }
    out
}

/// Index a single book end-to-end. Synchronous; intended to run in a
/// `spawn_blocking` task. Returns the number of chunks indexed.
///
/// The `progress` callback receives `(current, total)` chapter counts so
/// the UI can render a bar. It's called once per chapter completed.
pub fn index_book<F>(
    book_id: i64,
    book_path: &str,
    cache_dir: PathBuf,
    db_path: &Path,
    mut progress: F,
) -> Result<usize, String>
where
    F: FnMut(usize, usize),
{
    embed::ensure_loaded(cache_dir)?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    let chapters = extract_chapters(Path::new(book_path))?;
    let total = chapters.len();
    if total == 0 {
        return Err("Book has no extractable text".to_string());
    }

    // Open our own connection so we don't deadlock the main one held by
    // the Tauri state.
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    db::clear_book_chunks(&conn, book_id).map_err(|e| e.to_string())?;
    db::set_index_status(&conn, book_id, "indexing", 0, None, None).map_err(|e| e.to_string())?;

    let mut chunks_count = 0usize;
    for (i, chapter) in chapters.iter().enumerate() {
        let chunks = chunker::chunk_text(&chapter.text);
        if chunks.is_empty() {
            progress(i + 1, total);
            continue;
        }
        let embeddings = embed::embed_sync(chunks.clone())?;
        if embeddings.len() != chunks.len() {
            return Err(format!(
                "Embedding count {} doesn't match chunks {}",
                embeddings.len(),
                chunks.len()
            ));
        }
        for (chunk_idx, (text, emb)) in chunks.iter().zip(embeddings.iter()).enumerate() {
            let blob = embed::embedding_to_blob(emb);
            db::insert_chunk(
                &conn,
                book_id,
                chapter.spine_index as i64,
                chunk_idx as i64,
                text,
                &blob,
                now_ms,
            )
            .map_err(|e| e.to_string())?;
            chunks_count += 1;
        }
        progress(i + 1, total);
    }

    db::set_index_status(
        &conn,
        book_id,
        "ready",
        chunks_count as i64,
        Some(now_ms),
        None,
    )
    .map_err(|e| e.to_string())?;

    Ok(chunks_count)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchHit {
    pub book_id: i64,
    pub spine_index: i64,
    pub text: String,
    pub score: f32,
}

/// Search the chunk DB by query embedding, return top-K hits by cosine
/// similarity. If `book_id` is Some, restrict to that book.
pub fn search_chunks(
    conn: &Connection,
    query_emb: &[f32],
    book_id: Option<i64>,
    top_k: usize,
) -> Result<Vec<SearchHit>, String> {
    let rows = db::list_chunks(conn, book_id).map_err(|e| e.to_string())?;
    let mut scored: Vec<(f32, &db::ChunkRow)> = rows
        .iter()
        .map(|r| {
            let emb = embed::blob_to_embedding(&r.embedding);
            let s = embed::cosine(query_emb, &emb);
            (s, r)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored
        .into_iter()
        .take(top_k)
        .map(|(score, row)| SearchHit {
            book_id: row.book_id,
            spine_index: row.spine_index,
            text: row.text.clone(),
            score,
        })
        .collect())
}
