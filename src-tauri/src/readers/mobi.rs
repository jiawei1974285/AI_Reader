use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chardetng::EncodingDetector;
use mobi::headers::TextEncoding;
use mobi::Mobi;
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

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

#[derive(Clone)]
struct MobiChapter {
    label: String,
    html: String,
}

/// Single-slot cache for the most recently opened MOBI. Reading a book is a
/// sequential per-chapter operation, so a single slot covers ~100% of intra-
/// session traffic. Replaced on book switch (different path) or staleness
/// (mtime moved — e.g., library watcher saw a rewrite).
///
/// Avoids re-running `content_as_string_lossy` + `collect_image_data_uris`
/// (which base64-encodes every embedded image) on every chapter flip — those
/// dominate cold-call latency on image-heavy MOBI.
struct MobiCache {
    path: PathBuf,
    mtime: Option<SystemTime>,
    title: String,
    author: String,
    body_len: usize,
    chapters: Vec<MobiChapter>,
}

static MOBI_CACHE: LazyLock<Mutex<Option<MobiCache>>> = LazyLock::new(|| Mutex::new(None));

/// One per-call view of the parsed MOBI; cheap to clone (Vec of String).
struct ParsedView {
    title: String,
    author: String,
    body_len: usize,
    chapters: Vec<MobiChapter>,
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

/// Returns a parsed view of the MOBI body — from cache when the same file
/// hasn't been touched, otherwise parses fresh and refills the cache.
fn cached_or_parse(path: &Path) -> Result<ParsedView, String> {
    let mtime = file_mtime(path);
    {
        let guard = MOBI_CACHE.lock().unwrap();
        if let Some(c) = guard.as_ref() {
            if c.path == path && c.mtime == mtime {
                return Ok(ParsedView {
                    title: c.title.clone(),
                    author: c.author.clone(),
                    body_len: c.body_len,
                    chapters: c.chapters.clone(),
                });
            }
        }
    }

    let (title, author, body) = read_body(path)?;
    let body_len = body.len();
    let chapters = split_chapters(&body);

    let entry = MobiCache {
        path: path.to_path_buf(),
        mtime,
        title: title.clone(),
        author: author.clone(),
        body_len,
        chapters: chapters.clone(),
    };
    *MOBI_CACHE.lock().unwrap() = Some(entry);

    Ok(ParsedView {
        title,
        author,
        body_len,
        chapters,
    })
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
/// Per-file caching is done one layer up in `cached_or_parse`.
///
/// Returns (title, author, body_html). `body_html` already has images
/// inlined as `data:` URIs so the webview can render them without needing
/// to extract anything to disk.
fn read_body(path: &Path) -> Result<(String, String, String), String> {
    let m = open(path)?;
    // Don't trust mobi-rs's header-declared encoding — Chinese MOBIs often
    // declare UTF-8 but contain GBK/GB18030 bytes (older Calibre conversions,
    // third-party Kindle tools, etc.). Run chardetng on raw bytes instead.
    let bytes = m.content_as_bytes();
    let body = decode_content_bytes(&bytes, m.text_encoding());
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

/// Decode raw MOBI content bytes to a String. Strategy:
///   1. Try strict UTF-8 — clean books win immediately, zero overhead.
///   2. Else decode UTF-8 lossy and measure the U+FFFD rate. This is
///      the "MOBI is *almost* UTF-8 with a few corrupt bytes" case —
///      preserves 95%+ correct Chinese with sprinkled `�`, which is
///      MUCH better than wholesale switching encodings.
///   3. Only when UTF-8 lossy is genuinely bad (>5% `�`) do we trust
///      chardetng to pick a different encoding. With a `cn` TLD hint
///      so it prefers CJK encodings over Latin-1 when evidence is
///      ambiguous (without the hint chardetng picks Windows-1252 for
///      Chinese MOBIs, producing `è½å~ç»æžå`-style garbage).
///
/// `header_hint` is only logged for diagnostics — we don't trust it.
fn decode_content_bytes(bytes: &[u8], header_hint: TextEncoding) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }

    let utf8_lossy: String = String::from_utf8_lossy(bytes).into_owned();
    let utf8_fffd_rate = fffd_rate(&utf8_lossy);

    // Threshold tuned for the observed split:
    //   - Real "mostly UTF-8" books: <1% FFFD
    //   - Wholesale encoding mismatch: 30-50% FFFD
    // 5% is well above the former and well below the latter.
    if utf8_fffd_rate < 0.05 {
        eprintln!(
            "[mobi/aireader] decode_content_bytes: {} bytes, header={:?}, \
             utf8_lossy clean enough (fffd_rate={:.4}) → kept as UTF-8",
            bytes.len(),
            header_hint,
            utf8_fffd_rate
        );
        return utf8_lossy;
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    // `cn` TLD biases toward GBK/GB18030 over Latin-1 when statistics are
    // borderline — essential for CJK MOBIs whose body bytes contain enough
    // high-bit distribution to look "Western" to a naive detector.
    let guessed = detector.guess(Some(b"cn"), true);
    let (guess_text, _, had_errors) = guessed.decode(bytes);
    let guess_fffd_rate = fffd_rate(&guess_text);

    // Final safety net: if chardetng's pick is WORSE than UTF-8 lossy
    // (rare, but possible on truly garbled files), keep UTF-8 lossy.
    let pick_guess = guess_fffd_rate + 0.02 < utf8_fffd_rate;
    eprintln!(
        "[mobi/aireader] decode_content_bytes: {} bytes, header={:?}, \
         utf8_fffd={:.4}, chardetng={} (fffd={:.4}, errors={}), picked={}",
        bytes.len(),
        header_hint,
        utf8_fffd_rate,
        guessed.name(),
        guess_fffd_rate,
        had_errors,
        if pick_guess { guessed.name() } else { "utf-8 (lossy)" }
    );

    if pick_guess {
        guess_text.into_owned()
    } else {
        utf8_lossy
    }
}

fn fffd_rate(s: &str) -> f64 {
    let total = s.chars().count();
    if total == 0 {
        return 0.0;
    }
    let bad = s.chars().filter(|c| *c == '\u{FFFD}').count();
    bad as f64 / total as f64
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

// Catches every `<img …/>` in the body so we can decide per-tag how to
// resolve it. Real-world MOBI markup we've seen:
//   <img recindex="0001"/>                          ← classic MOBI / KF7
//   <img src="kindle:embed:0001?mime=image/jpeg"/>  ← KF8
//   <img src="kindle:embed:0001"/>                  ← shorter KF8 variant
//   <img src="img00001.jpg"/>                       ← some Calibre presets
//   <img src="..."/> (anything else)                ← unknown converter quirks
static IMG_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<img\b([^>]*?)/?>"#).unwrap());
static ATTR_RECINDEX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)\brecindex\s*=\s*["']?0*(\d+)["']?"#).unwrap());
static ATTR_KINDLE_EMBED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\bsrc\s*=\s*["']kindle:embed:0*(\d+)[^"']*["']"#).unwrap()
});

fn inline_mobi_images(body: &str, images: &HashMap<usize, String>) -> String {
    // Track stats so we can diagnose mis-rendering MOBIs from the dev console
    // — without these we can't tell "this book has no images" apart from
    // "we have the records but failed to match the tag syntax".
    let mut total = 0usize;
    let mut by_recindex = 0usize;
    let mut by_kindle = 0usize;
    let mut by_sequential = 0usize;
    let mut dropped = 0usize;
    // Sequential fallback uses ordinals (1-based). `collect_image_data_uris`
    // inserts every image under its ordinal key 1..=N, plus its record_index
    // and record_index-first_image+1 — that triple-keying makes recindex
    // lookup tolerant of all three numbering schemes seen in real MOBIs.
    let mut seq_counter = 1usize;
    let mut first_unmatched: Option<String> = None;

    let out = IMG_TAG_RE.replace_all(body, |caps: &regex::Captures| -> String {
        total += 1;
        let attrs = caps.get(1).map(|m| m.as_str()).unwrap_or("");

        // 1. recindex="N" — canonical MOBI / KF7 reference. HashMap will
        //    match against ordinal OR raw record_index OR offset-from-first,
        //    so we don't have to guess which numbering this MOBI uses.
        if let Some(m) = ATTR_RECINDEX_RE.captures(attrs) {
            if let Ok(n) = m.get(1).unwrap().as_str().parse::<usize>() {
                if let Some(uri) = images.get(&n) {
                    by_recindex += 1;
                    return format!(r#"<img src="{}" />"#, uri);
                }
            }
        }
        // 2. src="kindle:embed:N" — KF8 reference
        if let Some(m) = ATTR_KINDLE_EMBED_RE.captures(attrs) {
            if let Ok(n) = m.get(1).unwrap().as_str().parse::<usize>() {
                if let Some(uri) = images.get(&n) {
                    by_kindle += 1;
                    return format!(r#"<img src="{}" />"#, uri);
                }
            }
        }
        // 3. Sequential fallback for unknown tag syntax (e.g. Calibre's
        //    img00001.jpg form). Image records appear in document order in
        //    every MOBI we've inspected, so by-ordinal assignment recovers
        //    images even when the tag carries no resolvable reference.
        if let Some(uri) = images.get(&seq_counter) {
            if first_unmatched.is_none() {
                first_unmatched = Some(attrs.chars().take(120).collect());
            }
            seq_counter += 1;
            by_sequential += 1;
            return format!(r#"<img src="{}" />"#, uri);
        }
        // 4. Ran out of records — drop the tag (CSS would hide it anyway).
        if first_unmatched.is_none() {
            first_unmatched = Some(attrs.chars().take(120).collect());
        }
        dropped += 1;
        String::new()
    });

    if total > 0 || !images.is_empty() {
        eprintln!(
            "[mobi/aireader] inline_mobi_images: {tags} <img> tags, {keys} image-record keys \
             (~{imgs} images) | matched: recindex={ri} kindle={ki} sequential={seq} dropped={dr} \
             | first_unmatched_attrs={unmatched:?}",
            tags = total,
            keys = images.len(),
            // `collect_image_data_uris` inserts ~2-3 keys per image.
            imgs = images.len() / 3,
            ri = by_recindex,
            ki = by_kindle,
            seq = by_sequential,
            dr = dropped,
            unmatched = first_unmatched,
        );
    }

    out.into_owned()
}

// (Both versions' resolve helpers were inlined into `inline_mobi_images`
// above — recindex/kindle/sequential branches now do their own HashMap
// lookup and format the replacement directly.)

#[tauri::command]
pub fn read_mobi_initial(path: String) -> Result<EpubPreview, String> {
    read_mobi_chapter(path, 0)
}

#[tauri::command]
pub fn read_mobi_chapter(path: String, spine_index: usize) -> Result<EpubPreview, String> {
    guard("MOBI 章节", || {
        let p = Path::new(&path);
        let view = cached_or_parse(p)?;
        let total = view.chapters.len();
        if spine_index >= total {
            return Err(format!("spine_index {spine_index} out of range (0..{total})"));
        }
        let ch = &view.chapters[spine_index];

        Ok(EpubPreview {
            title: view.title,
            author: view.author,
            raw_length: view.body_len,
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
        let view = cached_or_parse(p)?;
        Ok(view
            .chapters
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
