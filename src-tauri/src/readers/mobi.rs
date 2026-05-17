use mobi::Mobi;
use std::path::Path;

use crate::readers::epub::{EpubPreview, TocEntry};

/// MOBI 支持采取最小可行策略：
/// - 元数据：`title()` / `author()` 直接走 mobi crate
/// - 正文：`content_as_string_lossy()` 一次拿到整本 HTML / 文本
/// - 章节切分：MOBI 用 `<mbp:pagebreak/>` 分章。我们按这个标签切；
///   切不出来时 fallback 到「按长度等分」的伪章节（每 ~4000 字一节），
///   行为和 TXT reader 的 "全文" 兜底一致，避免空目录
/// - 不支持 DRM 加密的 MOBI / KF8-only 文件 (那是 mobi crate 的限制)
/// - 不抽封面 (v1)：mobi crate 提供 `image_records()` 但没有「哪个是封面」
///   的稳定指标 (依赖 EXTH 105/201 record offset)，先不做，用 placeholder

const FALLBACK_CHUNK_CHARS: usize = 4000;

struct MobiChapter {
    label: String,
    html: String,
}

fn open(path: &Path) -> Result<Mobi, String> {
    Mobi::from_path(path).map_err(|e| format!("MOBI 解析失败: {e}"))
}

/// Try to split MOBI body HTML at `<mbp:pagebreak/>`. If we can't find any,
/// fall back to a length-based split so the reader UI still has something
/// to page through.
fn split_chapters(body: &str) -> Vec<MobiChapter> {
    // Common variants of the page-break tag across MOBI generators.
    let markers = [
        "<mbp:pagebreak/>",
        "<mbp:pagebreak />",
        "<mbp:pagebreak></mbp:pagebreak>",
        "<div class=\"mbp_pagebreak\"></div>",
    ];

    let mut pieces: Vec<&str> = vec![body];
    for marker in markers.iter() {
        let mut next: Vec<&str> = Vec::new();
        for p in pieces.drain(..) {
            for sub in p.split(marker) {
                next.push(sub);
            }
        }
        pieces = next;
    }

    let mut chapters: Vec<MobiChapter> = pieces
        .into_iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(i, s)| MobiChapter {
            label: derive_label(s, i),
            html: s.to_string(),
        })
        .collect();

    // If pagebreak yielded only one "chapter" but the book is long, slice
    // by character count as a fallback.
    if chapters.len() <= 1 && body.chars().count() > FALLBACK_CHUNK_CHARS {
        chapters = chunk_by_chars(body, FALLBACK_CHUNK_CHARS);
    }

    if chapters.is_empty() {
        chapters.push(MobiChapter {
            label: "全文".to_string(),
            html: body.to_string(),
        });
    }
    chapters
}

/// Look for an <h1>/<h2>/<h3> at the top of the chapter's HTML to use as
/// a label; otherwise just say "第 N 章".
fn derive_label(html: &str, idx: usize) -> String {
    for tag in ["<h1", "<h2", "<h3"] {
        if let Some(start) = html.find(tag) {
            if let Some(close) = html[start..].find('>') {
                let content_start = start + close + 1;
                if let Some(end_rel) = html[content_start..].find("</") {
                    let raw = &html[content_start..content_start + end_rel];
                    let stripped = strip_tags(raw).trim().to_string();
                    if !stripped.is_empty() && stripped.chars().count() <= 60 {
                        return stripped;
                    }
                }
            }
        }
    }
    format!("第 {} 章", idx + 1)
}

fn chunk_by_chars(text: &str, n: usize) -> Vec<MobiChapter> {
    let mut chapters = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let mut start = 0;
    let mut idx = 0;
    while start < total {
        let end = (start + n).min(total);
        let slice: String = chars[start..end].iter().collect();
        chapters.push(MobiChapter {
            label: format!("第 {} 节", idx + 1),
            html: slice,
        });
        start = end;
        idx += 1;
    }
    chapters
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

/// Read raw MOBI body once; called by both initial / chapter / toc paths.
/// MOBI is small enough (median ~1-5 MB) that re-parsing per call is fine
/// and saves us a cache layer.
fn read_body(path: &Path) -> Result<(String, String, String), String> {
    let m = open(path)?;
    let body = m.content_as_string_lossy();
    let title = {
        let t = m.title();
        if t.trim().is_empty() {
            title_from_path(path)
        } else {
            t
        }
    };
    let author = m.author().unwrap_or_default();
    Ok((title, author, body))
}

#[tauri::command]
pub fn read_mobi_initial(path: String) -> Result<EpubPreview, String> {
    read_mobi_chapter(path, 0)
}

#[tauri::command]
pub fn read_mobi_chapter(path: String, spine_index: usize) -> Result<EpubPreview, String> {
    let p = Path::new(&path);
    let (title, author, body) = read_body(p)?;
    let chapters = split_chapters(&body);
    let total = chapters.len();
    if spine_index >= total {
        return Err(format!("spine_index {spine_index} out of range (0..{total})"));
    }
    let ch = &chapters[spine_index];

    Ok(EpubPreview {
        title,
        author,
        raw_length: body.len(),
        extracted_length: ch.html.len(),
        html: ch.html.clone(),
        spine_index,
        spine_total: total,
    })
}

#[tauri::command]
pub fn get_mobi_toc(path: String) -> Result<Vec<TocEntry>, String> {
    let p = Path::new(&path);
    let (_t, _a, body) = read_body(p)?;
    let chapters = split_chapters(&body);
    Ok(chapters
        .iter()
        .enumerate()
        .map(|(i, ch)| TocEntry {
            spine_index: i,
            label: ch.label.clone(),
            depth: 0,
        })
        .collect())
}

/// Used by the library scanner — like EPUB's extract_metadata, returns
/// (title, author). Errors propagate; scanner already handles fallback.
pub fn extract_metadata(path: &Path) -> Result<(String, String), String> {
    let m = open(path)?;
    let title = {
        let t = m.title();
        if t.trim().is_empty() {
            title_from_path(path)
        } else {
            t
        }
    };
    let author = m.author().unwrap_or_default();
    Ok((title, author))
}
