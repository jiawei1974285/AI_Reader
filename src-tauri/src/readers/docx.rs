use docx_rs::*;
use std::fs;
use std::path::Path;

use crate::readers::epub::{EpubPreview, TocEntry};

fn read_docx_to_html(path: &Path) -> Result<(String, String), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;
    let docx = read_docx(&bytes).map_err(|e| format!("Failed to parse docx: {e:?}"))?;

    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    let mut html = String::new();

    for child in &docx.document.children {
        if let DocumentChild::Paragraph(p) = child {
            let text = paragraph_text(p);
            if text.trim().is_empty() {
                continue;
            }
            let escaped = escape_html(text.trim());
            let level = heading_level_from_paragraph(p);
            if let Some(lvl) = level {
                html.push_str(&format!("<h{lvl}>{escaped}</h{lvl}>"));
            } else {
                html.push_str("<p>");
                html.push_str(&escaped);
                html.push_str("</p>");
            }
        }
    }

    Ok((title, html))
}

fn paragraph_text(p: &Paragraph) -> String {
    let mut s = String::new();
    for child in &p.children {
        if let ParagraphChild::Run(r) = child {
            for rc in &r.children {
                if let RunChild::Text(t) = rc {
                    s.push_str(&t.text);
                }
            }
        }
    }
    s
}

/// Try several places where docx might encode "this paragraph is a heading":
/// either the paragraph style id ("Heading1", "heading 1", "标题1"), or the
/// outline level on the paragraph property.
fn heading_level_from_paragraph(p: &Paragraph) -> Option<u8> {
    let style = p
        .property
        .style
        .as_ref()
        .map(|s| s.val.to_ascii_lowercase().replace(' ', ""))
        .unwrap_or_default();
    if style.starts_with("heading") || style.starts_with("\u{6807}\u{9898}") {
        let digits: String = style
            .chars()
            .filter(|c: &char| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<u8>() {
            if (1..=6).contains(&n) {
                return Some(n);
            }
        }
    }
    None
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

#[tauri::command]
pub fn read_docx_initial(path: String) -> Result<EpubPreview, String> {
    let (title, html) = read_docx_to_html(Path::new(&path))?;
    let raw_length = html.len();
    Ok(EpubPreview {
        title,
        author: "".to_string(),
        html,
        raw_length,
        extracted_length: raw_length,
        spine_index: 0,
        spine_total: 1,
    })
}

#[tauri::command]
pub fn read_docx_chapter(path: String, _spine_index: usize) -> Result<EpubPreview, String> {
    read_docx_initial(path)
}

#[tauri::command]
pub fn get_docx_toc(_path: String) -> Result<Vec<TocEntry>, String> {
    // For Phase 3.C we treat the whole DOCX as one chapter. If we later
    // split at H1 boundaries we can return real TOC entries here.
    Ok(vec![])
}
