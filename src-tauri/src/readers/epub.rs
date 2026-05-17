use ::epub::doc::{EpubDoc, NavPoint};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
        break;
    }

    build_preview(title, author, chosen_index, spine_total, chosen_raw)
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

    let raw = doc
        .get_resource_str(&spine[spine_index].idref)
        .map(|(c, _)| c)
        .unwrap_or_default();

    build_preview(title, author, spine_index, spine_total, raw)
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
    title: String,
    author: String,
    spine_index: usize,
    spine_total: usize,
    raw: String,
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
    let cleaned = strip_visual(&body);
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

/// Strip visual/asset tags that won't load (relative paths can't resolve in
/// the webview) and would otherwise produce broken-image placeholders or noise.
fn strip_visual(html: &str) -> String {
    let s = SVG_RE.replace_all(html, "");
    let s = IMG_RE.replace_all(&s, "");
    let s = IMAGE_RE.replace_all(&s, "");
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
