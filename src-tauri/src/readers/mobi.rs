use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use mobi::headers::{Compression, Encryption, TextEncoding};
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
    if chapters.len() <= 1 {
        let heading_chapters = split_by_headings(body);
        if heading_chapters.len() > 1 {
            chapters = heading_chapters;
        } else if body.chars().count() > FALLBACK_CHUNK_CHARS {
            chapters = chunk_by_chars(body, FALLBACK_CHUNK_CHARS);
        }
    }

    if chapters.is_empty() {
        chapters.push(MobiChapter {
            label: "全文".to_string(),
            html: body.to_string(),
        });
    }
    chapters
}

static CHAPTER_HEADING_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<h[1-3]\b[^>]*>.*?</h[1-3]\s*>").unwrap());

fn split_by_headings(body: &str) -> Vec<MobiChapter> {
    let matches: Vec<_> = CHAPTER_HEADING_RE.find_iter(body).collect();
    if matches.len() <= 1 {
        return Vec::new();
    }

    let mut chapters = Vec::new();
    for (i, m) in matches.iter().enumerate() {
        let start = m.start();
        let end = matches
            .get(i + 1)
            .map(|next| next.start())
            .unwrap_or(body.len());
        let html = body[start..end].trim();
        if html.is_empty() {
            continue;
        }
        chapters.push(MobiChapter {
            label: derive_label(html, i),
            html: html.to_string(),
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
    if m.encryption() != Encryption::No {
        return Err(
            "这本书是加密的 AZW/MOBI 文件，当前无法解析正文。请换用无 DRM 的版本后再打开。"
                .to_string(),
        );
    }
    // Don't trust mobi-rs's header-declared encoding — Chinese MOBIs often
    // declare UTF-8 but contain GBK/GB18030 bytes (older Calibre conversions,
    // third-party Kindle tools, etc.). Run chardetng on raw bytes instead.
    let bytes = m.content_as_bytes();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // 注意: 这两个字段是 pub fields, 直接读不需 method (vendored crate)
    let mh = &m.metadata.mobi;
    let total_records = m.raw_records().records().len();
    tracing::info!(
        path = %path.display(),
        ext = %ext,
        compression = ?m.compression(),
        encryption = ?m.encryption(),
        text_encoding = ?m.text_encoding(),
        readable_range = ?m.readable_records_range(),
        first_huff_record = mh.first_huff_record,
        huff_record_count = mh.huff_record_count,
        first_image_index = mh.first_image_index,
        first_content_record = mh.first_content_record,
        first_non_book_index = mh.first_non_book_index,
        total_raw_records = total_records,
        content_bytes = bytes.len(),
        "mobi read_body — content extraction"
    );
    if bytes.is_empty() {
        // 如果是 Huff 压缩, 显式调一次 huff_data 拿具体 Err 暴露给日志.
        // content_as_bytes 内部 Err(_) → Vec::new() 把错误吞了, 这里展开.
        let huff_err_msg = if m.compression() == Compression::Huff {
            match m.huff_data() {
                Ok(_) => " (huff_data returned Ok but bytes empty — likely 0 sections)".to_string(),
                Err(e) => format!(" — huff decode error: {e:?}"),
            }
        } else {
            String::new()
        };
        tracing::error!(
            path = %path.display(),
            compression = ?m.compression(),
            huff_error = %huff_err_msg,
            "mobi read_body returned 0 bytes"
        );
        return Err(format!(
            "MOBI/AZW 读出 0 字节正文 (compression={:?}, range={:?}){}. \
             如果是 .azw3 Huff 压缩, 当前 mobi-rs vendor 解码失败. \
             可暂用 Calibre ebook-convert 转 EPUB 后再打开.",
            m.compression(),
            m.readable_records_range(),
            huff_err_msg
        ));
    }
    let body = decode_content_bytes(&bytes, m.text_encoding())?;
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

/// Decode raw MOBI content bytes to a String.
///
/// We deliberately don't trust any single signal:
///   - the MOBI header's encoding field lies for many Chinese books
///   - chardetng can pick UTF-8 for GBK content when the body has enough
///     ASCII scaffolding (HTML tags, numbers) — its statistics tilt
///     toward UTF-8 for "mostly-ASCII looking" inputs
///   - `String::from_utf8_lossy` can produce VALID-but-wrong CJK chars
///     when GBK lead bytes 0xE0-0xEF happen to form valid UTF-8 3-byte
///     leads — landing in rare/extension ideographs ("琛屾楃" pattern)
///     with no `�` markers to flag the failure
///
/// Strategy: try multiple candidate encodings in parallel and score by
/// CJK-common-zone density. The encoding whose decoded text places the
/// most characters in the GB2312 common region (0x4E00..0x82FF) and the
/// least in extension ranges (0x8300+, Ext-A) wins.
///
/// `header_hint` is only logged for diagnostics — we don't trust it.
fn decode_content_bytes(bytes: &[u8], header_hint: TextEncoding) -> Result<String, String> {
    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    // `cn` TLD biases toward GBK/GB18030 over Latin-1.
    let chardetng_pick = detector.guess(Some(b"cn"), true);

    // Candidate encodings to try. Order doesn't matter — we pick by score.
    // Dedupe by pointer identity since chardetng's pick is often UTF-8 or
    // one of the explicit candidates below.
    let candidates: [&'static Encoding; 4] = [
        chardetng_pick,
        encoding_rs::GBK,
        encoding_rs::GB18030,
        encoding_rs::UTF_8,
    ];

    let mut seen: Vec<&'static Encoding> = Vec::new();
    let mut best: Option<(&'static Encoding, String, f64)> = None;

    for enc in candidates.iter() {
        if seen.iter().any(|e| std::ptr::eq(*e, *enc)) {
            continue;
        }
        seen.push(*enc);

        let text = if std::ptr::eq(*enc, encoding_rs::UTF_8) {
            String::from_utf8_lossy(bytes).into_owned()
        } else {
            enc.decode(bytes).0.into_owned()
        };
        let s = decode_quality_score(&text);
        eprintln!(
            "[mobi/aireader] decode candidate: {} score={:.4}",
            enc.name(),
            s
        );
        if best.as_ref().map_or(true, |b| s > b.2) {
            best = Some((*enc, text, s));
        }
    }

    let (winner_enc, winner_text, winner_score) = best.unwrap_or_else(|| {
        (
            encoding_rs::UTF_8,
            String::from_utf8_lossy(bytes).into_owned(),
            0.0,
        )
    });

    eprintln!(
        "[mobi/aireader] decode_content_bytes: {} bytes, header_hint={:?}, \
         chardetng_pick={}, WINNER={} (score={:.4})",
        bytes.len(),
        header_hint,
        chardetng_pick.name(),
        winner_enc.name(),
        winner_score
    );

    let cleaned = sanitize_sparse_decode_markers(&winner_text);
    if decoded_body_is_garbage(&cleaned) {
        return Err(
            "这本书的 MOBI/AZW 正文压缩格式当前无法可靠解析，已停止显示乱码。请换用 EPUB、TXT 或无 DRM 的新版 AZW3。"
                .to_string(),
        );
    }

    Ok(cleaned)
}

/// Quality score for a decoded text candidate. Higher = better.
///
/// Built on three observations of CJK MOBI corpus:
///   1. Real Chinese text concentrates in the GB2312 common region —
///      0x4E00..=0x82FF (~6800 most-frequent ideographs). >90% of any
///      real Chinese page has chars in this range.
///   2. GBK-misread-as-UTF-8 (or any encoding mismatch) sprinkles chars
///      across the GBK/GB18030 extension ranges (0x8300..=0x9FFF) and
///      CJK Extension A (0x3400..=0x4DBF). Real text rarely lives here.
///   3. U+FFFD is a hard "couldn't decode" marker.
///
/// We reward common-zone CJK + ASCII, penalize extension-zone CJK + FFFD.
fn decode_quality_score(s: &str) -> f64 {
    let total = s.chars().count();
    if total == 0 {
        return 0.0;
    }
    let total_f = total as f64;

    let mut common = 0usize;
    let mut extended = 0usize;
    let mut ascii = 0usize;
    let mut fffd = 0usize;

    for c in s.chars() {
        let code = c as u32;
        if c == '\u{FFFD}' {
            fffd += 1;
        } else if code < 0x80 {
            ascii += 1;
        } else if (0x4E00..=0x82FF).contains(&code) {
            common += 1;
        } else if (0x8300..=0x9FFF).contains(&code) || (0x3400..=0x4DBF).contains(&code) {
            extended += 1;
        }
        // Other Unicode chars (punctuation, fullwidth, etc.) score neutral
    }

    (common as f64 / total_f) * 1.2 + (ascii as f64 / total_f) * 0.5
        - (extended as f64 / total_f) * 1.5
        - (fffd as f64 / total_f) * 1.0
}

fn sanitize_sparse_decode_markers(s: &str) -> String {
    let total = s.chars().count();
    if total == 0 {
        return String::new();
    }
    let bad = s.chars().filter(|c| matches!(*c, '\u{FFFD}' | '□')).count();
    if bad > 3 && (bad as f64 / total as f64) > 0.005 {
        return s.to_string();
    }
    s.chars()
        .filter(|c| !matches!(*c, '\u{FFFD}' | '□'))
        .collect()
}

fn decoded_body_is_garbage(s: &str) -> bool {
    let sample: String = s.chars().take(50_000).collect();
    let total = sample.chars().count();
    if total < 200 {
        return false;
    }

    let bad = sample
        .chars()
        .filter(|c| matches!(*c, '\u{FFFD}' | '□'))
        .count();
    let controls = sample
        .chars()
        .filter(|c| c.is_control() && !matches!(*c, '\n' | '\r' | '\t'))
        .count();
    // 问题 1: 之前 common_cjk 只到 0x82FF, 把"非中文"的日语扩展汉字 + 假名
    // (hiragana/katakana) + 韩文 (Hangul) 全判成"不可读", 导致日本作者
    // (例: 盐野七生《文艺复兴的故事 01》)、日韩 MOBI/AZW 被错判 garbage 报错.
    //
    // 修: 把 CJK Unified Ideographs 范围扩到 0x9FFF (覆盖几乎所有常用日韩中汉字),
    // 加 hiragana / katakana / Hangul 三段 readable 字符.
    // (CLAUDE.md 原则 6 内/外模型一致: 阅读器不是中文专用, 不该只认中文.)
    let cjk_ideographs = sample
        .chars()
        .filter(|c| ('\u{4E00}'..='\u{9FFF}').contains(c))
        .count();
    let kana_hangul = sample
        .chars()
        .filter(|c| {
            // Hiragana
            ('\u{3040}'..='\u{309F}').contains(c)
            // Katakana
            || ('\u{30A0}'..='\u{30FF}').contains(c)
            // CJK Symbols and Punctuation (《》 「」 〇 等)
            || ('\u{3000}'..='\u{303F}').contains(c)
            // Hangul Syllables (韩文)
            || ('\u{AC00}'..='\u{D7AF}').contains(c)
            // Halfwidth / Fullwidth Forms (常见标点)
            || ('\u{FF00}'..='\u{FFEF}').contains(c)
        })
        .count();
    let ascii = sample.chars().filter(|c| c.is_ascii()).count();
    let has_markup = sample.contains("<html")
        || sample.contains("<body")
        || sample.contains("<p")
        || sample.contains("<div");

    let total_f = total as f64;
    let bad_ratio = bad as f64 / total_f;
    let control_ratio = controls as f64 / total_f;
    let readable_ratio =
        (cjk_ideographs + kana_hangul + ascii) as f64 / total_f;

    bad_ratio > 0.02 || control_ratio > 0.02 || (!has_markup && readable_ratio < 0.45)
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
static ATTR_KINDLE_EMBED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)\bsrc\s*=\s*["']kindle:embed:0*(\d+)[^"']*["']"#).unwrap());

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
            return Err(format!(
                "spine_index {spine_index} out of range (0..{total})"
            ));
        }
        let ch = &view.chapters[spine_index];

        // A2: MOBI 来源同样不可信，过 ammonia 白名单。
        let safe_html = crate::readers::sanitize::clean(&ch.html);
        Ok(EpubPreview {
            title: view.title,
            author: view.author,
            raw_length: view.body_len,
            extracted_length: safe_html.len(),
            html: safe_html,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_chapters_uses_headings_when_pagebreaks_are_missing() {
        let body = r#"
            <h1>第一章</h1><p>alpha</p>
            <h1>第二章</h1><p>beta</p>
            <h2>第三章</h2><p>gamma</p>
        "#;

        let chapters = split_chapters(body);

        assert_eq!(chapters.len(), 3);
        assert!(chapters[0].html.contains("alpha"));
        assert!(chapters[1].html.contains("beta"));
        assert!(chapters[2].html.contains("gamma"));
    }

    #[test]
    fn sparse_decode_markers_are_removed() {
        let text = "纳兰小姐问道：谁教你是汉人？\u{FFFD}教你的\u{FFFD}";

        let cleaned = sanitize_sparse_decode_markers(text);

        assert_eq!(cleaned, "纳兰小姐问道：谁教你是汉人？教你的");
    }

    #[test]
    fn dense_decode_markers_are_treated_as_garbage() {
        let text = "A\u{FFFD}B□C".repeat(200);

        assert_eq!(sanitize_sparse_decode_markers(&text), text);
        assert!(decoded_body_is_garbage(&text));
    }

    /// 问题 1 回归: 之前 common_cjk 只到 0x82FF, 日语 hiragana / katakana
    /// 被算成"不可读", 整本日语书会被错判 garbage.
    /// 这里用一段全 hiragana + katakana + 常用 CJK + 标点的日语样本验证.
    #[test]
    fn japanese_book_not_flagged_as_garbage() {
        // 来自盐野七生《文艺复兴的故事》典型句式: 汉字 + 假名 + 标点混合
        let sample = "ルネサンスとは何か。それは、人間の発見と、世界の発見\
                      である。一四世紀のイタリアから始まったこの大きな精神\
                      運動は、ヨーロッパ全域に広がり、近代という新しい時代\
                      の幕を開けた。フィレンツェ、ローマ、ヴェネツィア——\
                      かつての都市国家たちが、競い合いながら芸術と思想を\
                      磨き上げていった。レオナルド、ミケランジェロ、ラファ\
                      エロといった巨匠たちの作品は、いまもなお我々を魅了\
                      してやまない。"
            .repeat(20); // 让样本足够长以触发 garbage 检测路径
        assert!(
            !decoded_body_is_garbage(&sample),
            "日语典型样本被误判 garbage"
        );
    }

    #[test]
    fn korean_book_not_flagged_as_garbage() {
        // Hangul + 少量汉字 + ASCII 标点
        let sample = "한국 문학의 깊이는 그 역사만큼이나 풍부하다. \
                      서울에서 시작된 근현대 문학은 식민지 시대와 분단의 \
                      아픔을 거치며 독자적인 색채를 띠게 되었다. 김소월, \
                      박경리, 최인훈 등의 작가들은 한국어의 가능성을 \
                      한계까지 밀어붙였다."
            .repeat(20);
        assert!(
            !decoded_body_is_garbage(&sample),
            "韩语典型样本被误判 garbage"
        );
    }
}
