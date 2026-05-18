use ::epub::doc::{EpubDoc, NavPoint};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

/// Light-touch metadata extraction used by the library scanner. Does not
/// touch spine content, so it's fast.
pub fn extract_metadata(path: &Path) -> Result<(String, String), String> {
    let doc = EpubDoc::new(path).map_err(|e| e.to_string())?;
    let title = doc.get_title().unwrap_or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    });
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_else(|| "Unknown".to_string());
    Ok((title, author))
}

/// Extract the EPUB cover image as (bytes, mime). Returns None if the
/// EPUB has no cover declared or it can't be loaded.
pub fn extract_cover(path: &Path) -> Option<(Vec<u8>, String)> {
    let mut doc = EpubDoc::new(path).ok()?;
    doc.get_cover()
}

#[derive(Serialize)]
pub struct EpubPreview {
    pub title: String,
    pub author: String,
    pub html: String,
    pub raw_length: usize,
    pub extracted_length: usize,
    pub spine_index: usize,
    pub spine_total: usize,
}

/// Open an EPUB and auto-find the first substantive text chapter, skipping
/// cover SVG pages, nav documents, and TOC-like pages.
#[tauri::command]
pub fn read_epub_preview(path: String) -> Result<EpubPreview, String> {
    let mut doc = EpubDoc::new(Path::new(&path))
        .map_err(|e| format!("Failed to open EPUB: {e}"))?;

    let title = doc.get_title().unwrap_or_else(|| "Untitled".to_string());
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let nav_id = doc.get_nav_id();
    let spine = doc.spine.clone();
    let spine_total = spine.len();

    let mut chosen_index = 0usize;
    let mut chosen_raw = String::new();
    let mut chosen_idref = String::new();
    for (idx, item) in spine.iter().enumerate() {
        // EPUB 3: explicit nav document is the TOC.
        if nav_id.as_deref() == Some(item.idref.as_str()) {
            continue;
        }
        let Some((content, _mime)) = doc.get_resource_str(&item.idref) else {
            continue;
        };
        let stripped = strip_visual(&content);
        if visible_char_count(&stripped) < 50 {
            continue;
        }
        if looks_like_toc(&stripped) {
            continue;
        }
        chosen_index = idx;
        chosen_raw = content;
        chosen_idref = item.idref.clone();
        break;
    }

    build_preview(&mut doc, title, author, chosen_index, spine_total, chosen_raw, &chosen_idref)
}

/// Open a specific spine item by index. Used for prev/next navigation and
/// for restoring saved reading progress.
#[tauri::command]
pub fn read_epub_chapter(path: String, spine_index: usize) -> Result<EpubPreview, String> {
    let mut doc = EpubDoc::new(Path::new(&path))
        .map_err(|e| format!("Failed to open EPUB: {e}"))?;

    let title = doc.get_title().unwrap_or_else(|| "Untitled".to_string());
    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let spine = doc.spine.clone();
    let spine_total = spine.len();
    if spine_index >= spine_total {
        return Err(format!(
            "spine_index {spine_index} out of range (0..{spine_total})"
        ));
    }

    let idref = spine[spine_index].idref.clone();
    let raw = doc
        .get_resource_str(&idref)
        .map(|(c, _)| c)
        .unwrap_or_default();

    build_preview(&mut doc, title, author, spine_index, spine_total, raw, &idref)
}

#[derive(Serialize, Clone)]
pub struct TocEntry {
    pub spine_index: usize,
    pub label: String,
    pub depth: usize,
}

/// Extract the book's table of contents and map each entry to a spine index
/// so the frontend can jump directly to chapters.
///
/// Strategy: prefer the EPUB's native nav document. If absent (some
/// publisher-converted EPUBs ship without nav.xhtml), fall back to walking
/// the spine and harvesting `<h1>/<h2>/<h3>` headings as chapter labels.
#[tauri::command]
pub fn get_book_toc(path: String) -> Result<Vec<TocEntry>, String> {
    let mut doc = EpubDoc::new(Path::new(&path))
        .map_err(|e| format!("Failed to open EPUB: {e}"))?;

    let mut path_to_idx: HashMap<PathBuf, usize> = HashMap::new();
    for (idx, item) in doc.spine.iter().enumerate() {
        if let Some(res) = doc.resources.get(&item.idref) {
            path_to_idx.insert(res.path.clone(), idx);
        }
    }

    let mut entries: Vec<TocEntry> = Vec::new();
    walk_toc(&doc.toc, 0, &path_to_idx, &mut entries);

    if entries.is_empty() {
        // Heuristic fallback: scan each spine item for a heading
        let nav_id = doc.get_nav_id();
        let spine = doc.spine.clone();
        for (idx, item) in spine.iter().enumerate() {
            if nav_id.as_deref() == Some(item.idref.as_str()) {
                continue;
            }
            let Some((content, _mime)) = doc.get_resource_str(&item.idref) else {
                continue;
            };
            let stripped = strip_visual(&content);
            if visible_char_count(&stripped) < 30 {
                continue;
            }
            let label = extract_chapter_label(&stripped)
                .unwrap_or_else(|| format!("第 {} 节", idx + 1));
            entries.push(TocEntry {
                spine_index: idx,
                label,
                depth: 0,
            });
        }
    }

    Ok(entries)
}

static HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<h[1-6][^>]*>(.*?)</h[1-6]\s*>").unwrap()
});

/// Try to find a chapter label inside an HTML fragment. Prefers headings;
/// falls back to the first ~30 visible characters.
fn extract_chapter_label(html: &str) -> Option<String> {
    if let Some(caps) = HEADING_RE.captures(html) {
        if let Some(inner) = caps.get(1) {
            let text = strip_inline_tags(inner.as_str()).trim().to_string();
            if !text.is_empty() && text.chars().count() <= 60 {
                return Some(text);
            }
        }
    }
    let mut buf = String::new();
    let mut in_tag = false;
    let mut count = 0;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => {
                if !(c.is_whitespace() && buf.is_empty()) {
                    buf.push(c);
                    count += 1;
                    if count >= 30 {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let trimmed = buf.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn strip_inline_tags(s: &str) -> String {
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

fn walk_toc(
    nodes: &[NavPoint],
    depth: usize,
    path_to_idx: &HashMap<PathBuf, usize>,
    out: &mut Vec<TocEntry>,
) {
    for n in nodes {
        if let Some(&idx) = path_to_idx.get(&n.content) {
            out.push(TocEntry {
                spine_index: idx,
                label: n.label.trim().to_string(),
                depth,
            });
        }
        walk_toc(&n.children, depth + 1, path_to_idx, out);
    }
}

fn build_preview(
    doc: &mut EpubDoc<BufReader<std::fs::File>>,
    title: String,
    author: String,
    spine_index: usize,
    spine_total: usize,
    raw: String,
    chapter_idref: &str,
) -> Result<EpubPreview, String> {
    if raw.is_empty() {
        return Ok(EpubPreview {
            title,
            author,
            html: "<p>(empty chapter)</p>".to_string(),
            raw_length: 0,
            extracted_length: 0,
            spine_index,
            spine_total,
        });
    }
    let body = extract_body_inner(&raw);
    // Inline images BEFORE strip_visual so they survive the cleanup pass.
    // Without this every <img> ref would either 404 (relative path can't
    // resolve in webview) or be deleted by strip_visual.
    let with_images = inline_images(doc, chapter_idref, &body);
    let cleaned = strip_visual(&with_images);
    Ok(EpubPreview {
        title,
        author,
        raw_length: raw.len(),
        extracted_length: cleaned.len(),
        html: cleaned,
        spine_index,
        spine_total,
    })
}

static IMG_SRC_RE: LazyLock<Regex> = LazyLock::new(|| {
    // Matches <img ... src="path" ...> and captures the src value.
    // Permissive on attribute order, single/double quotes, and self-close.
    Regex::new(r#"(?is)<img\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*?)/?>"#).unwrap()
});

/// Walk every <img> in the chapter HTML, try to resolve its src against the
/// chapter's location inside the EPUB, and rewrite the src to a data: URI
/// with the image inlined as base64.
///
/// Images that can't be resolved (missing in the epub, or absolute http
/// URLs) are left untouched — strip_visual will drop the un-rewritten ones
/// afterwards to avoid broken-image placeholders.
fn inline_images(
    doc: &mut EpubDoc<BufReader<std::fs::File>>,
    chapter_idref: &str,
    html: &str,
) -> String {
    let Some(chapter_path) = doc
        .resources
        .get(chapter_idref)
        .map(|r| r.path.clone())
    else {
        return html.to_string();
    };
    let chapter_dir = chapter_path.parent().map(Path::to_path_buf).unwrap_or_default();

    // Pre-collect matches so we can mutate `doc` inside the replacement
    // loop (replace_all's closure can't borrow doc mutably).
    let mut replacements: Vec<(String, String)> = Vec::new();
    for caps in IMG_SRC_RE.captures_iter(html) {
        let whole = caps.get(0).unwrap().as_str().to_string();
        let src = caps.get(2).unwrap().as_str();

        // Skip absolute URLs and already-inlined data: URIs.
        if src.starts_with("data:") || src.starts_with("http://") || src.starts_with("https://") {
            continue;
        }

        let resolved = resolve_path_against(&chapter_dir, src);
        let Some(bytes) = doc.get_resource_by_path(&resolved) else {
            continue;
        };
        let mime = doc
            .get_resource_mime_by_path(&resolved)
            .unwrap_or_else(|| guess_mime_from_ext(&resolved));
        let data_uri = format!("data:{};base64,{}", mime, B64.encode(&bytes));
        let new_tag = whole.replacen(src, &data_uri, 1);
        replacements.push((whole, new_tag));
    }

    let mut out = html.to_string();
    for (old, new) in replacements {
        // Single-occurrence replace per unique tag is fine; repeated
        // identical img tags get the same replacement which is OK.
        out = out.replacen(&old, &new, 1);
    }
    out
}

fn resolve_path_against(base_dir: &Path, src: &str) -> PathBuf {
    // EPUB hrefs are URL-encoded (e.g. spaces become %20). Decode common
    // entities before resolving against the zip filesystem.
    let decoded = url_decode(src);
    let joined = base_dir.join(decoded);
    normalize(&joined)
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            Component::Normal(s) => out.push(s),
            Component::RootDir | Component::Prefix(_) => out.push(comp.as_os_str()),
        }
    }
    out
}

fn guess_mime_from_ext(p: &Path) -> String {
    match p.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
    .to_string()
}

static SVG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<svg\b[^>]*>.*?</svg\s*>").unwrap());
static IMG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<img\b[^>]*/?>").unwrap());
static IMAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<image\b[^>]*/?>").unwrap());
static LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<link\b[^>]*/?>").unwrap());
static SCRIPT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<script\b[^>]*>.*?</script\s*>").unwrap());
static STYLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<style\b[^>]*>.*?</style\s*>").unwrap());
static ANCHOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<a\s").unwrap());

/// Detect TOC-like pages: many internal anchors and a high link-text ratio.
/// Real chapters rarely have more than a handful of hyperlinks per page.
fn looks_like_toc(html: &str) -> bool {
    ANCHOR_RE.find_iter(html).count() > 10
}

/// Strip visual/asset tags that won't load (relative paths can't resolve
/// in the webview) and would otherwise produce broken-image placeholders
/// or noise. Images that have already been inlined as `data:` URIs are
/// kept; only un-rewritten <img>/<image> with relative or unknown src
/// are dropped.
fn strip_visual(html: &str) -> String {
    let s = SVG_RE.replace_all(html, "");
    let s = IMG_RE.replace_all(&s, |caps: &regex::Captures| {
        let tag = caps.get(0).map(|m| m.as_str()).unwrap_or("");
        // Keep <img> only if it points at an inlined data URI we created.
        if tag.contains("src=\"data:") || tag.contains("src='data:") {
            tag.to_string()
        } else {
            String::new()
        }
    });
    let s = IMAGE_RE.replace_all(&s, |caps: &regex::Captures| {
        let tag = caps.get(0).map(|m| m.as_str()).unwrap_or("");
        if tag.contains("href=\"data:")
            || tag.contains("href='data:")
            || tag.contains("xlink:href=\"data:")
            || tag.contains("xlink:href='data:")
        {
            tag.to_string()
        } else {
            String::new()
        }
    });
    let s = LINK_RE.replace_all(&s, "");
    let s = SCRIPT_RE.replace_all(&s, "");
    let s = STYLE_RE.replace_all(&s, "");
    s.to_string()
}

/// Extract the inner content of <body>...</body>. EPUB chapters are full
/// XHTML documents; nested <html>/<head>/<body> via innerHTML renders
/// inconsistently across browsers, so we unwrap the body.
fn extract_body_inner(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(body_start_tag) = lower.find("<body") else {
        return html.to_string();
    };
    let Some(tag_end) = lower[body_start_tag..].find('>') else {
        return html.to_string();
    };
    let content_start = body_start_tag + tag_end + 1;
    let Some(body_close_rel) = lower[content_start..].find("</body>") else {
        return html[content_start..].to_string();
    };
    html[content_start..content_start + body_close_rel].to_string()
}

fn visible_char_count(html: &str) -> usize {
    let mut count = 0usize;
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag && !c.is_whitespace() => count += 1,
            _ => {}
        }
    }
    count
}
