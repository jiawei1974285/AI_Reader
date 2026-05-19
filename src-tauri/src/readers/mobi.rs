use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use mobi::Mobi;
use regex::Regex;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::LazyLock;

use crate::readers::epub::{EpubPreview, TocEntry};

/// Catch panics from the `mobi` crate (which is unmaintained at 0.8 and has
/// known panic sites on malformed records / certain KF8 variants). Without
/// this wrapper a panic in command-handler code escapes Tauri's worker and
/// kills the whole app process — silent crash, no error to the UI.
///
/// We don't try to be clever about UnwindSafe: command bodies don't mutate
/// state across the panic boundary (all DB state is behind Mutex, panic
/// inside the closure simply poisons nothing here), so AssertUnwindSafe is
/// the practical wrapper.
fn guard<T, F: FnOnce() -> Result<T, String>>(label: &str, f: F) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "(无消息)".to_string()
            };
            Err(format!("{label} 解析失败 (内部 panic)：{msg}"))
        }
    }
}

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
///
/// Returns (title, author, body_html). `body_html` already has images
/// inlined as `data:` URIs so the webview can render them without needing
/// to extract anything to disk.
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

    // Collect image records once and rewrite any <img recindex=…> in the
    // body to inlined data URIs. Errors in image extraction are swallowed
    // — text is more important than perfect image rendering.
    let images = collect_image_data_uris(&m);
    let body = inline_mobi_images(&body, &images);

    Ok((title, author, body))
}

/// Map of `recindex` (1-based, as it appears in MOBI HTML) to a fully
/// formed `data:image/...;base64,...` URI. `recindex` corresponds to the
/// N-th image record returned by `image_records()`.
fn collect_image_data_uris(m: &Mobi) -> HashMap<usize, String> {
    let mut images = HashMap::new();
    let first_image = m.metadata.mobi.first_image_index as usize;
    let records = m.raw_records();
    let mut ordinal = 1usize;

    for (record_index, record) in records.records().iter().enumerate().skip(first_image) {
        let bytes = record.content;
        let Some(mime) = detect_image_mime(bytes) else {
            continue;
        };
        let data_uri = format!("data:{};base64,{}", mime, B64.encode(bytes));

        images.insert(ordinal, data_uri.clone());
        images.insert(record_index, data_uri.clone());
        images.insert(record_index.saturating_sub(first_image) + 1, data_uri);
        ordinal += 1;
    }

    images
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("image/png")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

// Three patterns we see in real MOBI files for embedded image refs:
//   <img recindex="0001"/>                  ← classic MOBI / KF7
//   <img src="kindle:embed:0001?mime=image/jpeg"/>   ← some KF8
//   <img src="kindle:embed:0001"/>          ← shorter variant
static IMG_RECINDEX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<img\b([^>]*?)\brecindex\s*=\s*["']?(\d+)["']?([^>]*?)/?>"#).unwrap()
});
static IMG_KINDLE_EMBED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<img\b([^>]*?)\bsrc\s*=\s*["']kindle:embed:0*(\d+)[^"']*["']([^>]*?)/?>"#)
        .unwrap()
});

fn inline_mobi_images(body: &str, images: &HashMap<usize, String>) -> String {
    if images.is_empty() {
        return body.to_string();
    }
    let pass1 = IMG_RECINDEX_RE.replace_all(body, |caps: &regex::Captures| -> String {
        replace_with_data_uri(caps, images)
    });
    let pass2 = IMG_KINDLE_EMBED_RE.replace_all(&pass1, |caps: &regex::Captures| -> String {
        replace_with_data_uri(caps, images)
    });
    pass2.into_owned()
}

fn replace_with_data_uri(caps: &regex::Captures, images: &HashMap<usize, String>) -> String {
    let before = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    let n_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
    let after = caps.get(3).map(|m| m.as_str()).unwrap_or("");
    let Ok(n) = n_str.parse::<usize>() else {
        return caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string();
    };
    let Some(data_uri) = images.get(&n) else {
        // No matching image record — drop the tag so we don't show a
        // broken-image icon.
        return String::new();
    };
    format!(r#"<img{} src="{}"{} />"#, before, data_uri, after)
}

#[tauri::command]
pub fn read_mobi_initial(path: String) -> Result<EpubPreview, String> {
    read_mobi_chapter(path, 0)
}

#[tauri::command]
pub fn read_mobi_chapter(path: String, spine_index: usize) -> Result<EpubPreview, String> {
    guard("MOBI 章节", || {
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
    })
}

#[tauri::command]
pub fn get_mobi_toc(path: String) -> Result<Vec<TocEntry>, String> {
    guard("MOBI 目录", || {
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
    })
}

/// Used by the library scanner — like EPUB's extract_metadata, returns
/// (title, author). Errors propagate; scanner already handles fallback.
/// Wrapped in `guard` so a panic during scan (which iterates every MOBI
/// in the library) can't take down the whole app.
pub fn extract_metadata(path: &Path) -> Result<(String, String), String> {
    guard("MOBI 元数据", || extract_metadata_inner(path))
}

pub fn extract_text_chapters(path: &Path) -> Result<Vec<(usize, String)>, String> {
    guard("MOBI AI 文本", || {
        let (_title, _author, body) = read_body(path)?;
        Ok(split_chapters(&body)
            .into_iter()
            .enumerate()
            .map(|(idx, ch)| (idx, normalize_text(&strip_tags(&ch.html))))
            .filter(|(_, text)| text.chars().filter(|c| !c.is_whitespace()).count() >= 30)
            .collect())
    })
}

fn normalize_text(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_metadata_inner(path: &Path) -> Result<(String, String), String> {
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
