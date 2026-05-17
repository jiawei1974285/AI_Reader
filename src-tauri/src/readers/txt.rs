use chardetng::EncodingDetector;
use regex::Regex;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use crate::readers::epub::{EpubPreview, TocEntry};

/// Matches a Chinese chapter heading anchored at the start of a line.
/// Examples that match:
///   第一章 概述
///   第 12 章
///   第三回
///   序章 / 序言 / 楔子 / 引子 / 前言 / 后记 / 尾声
///   Chapter 5
static CHAPTER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^[\s\x{3000}]*(第\s*[一二三四五六七八九十百千万零〇0-9]+\s*[章节回卷篇][^\n]*|序章[^\n]*|序言[^\n]*|楔\s*子[^\n]*|引\s*子[^\n]*|前\s*言[^\n]*|后\s*记[^\n]*|尾\s*声[^\n]*|Chapter\s+\d+[^\n]*)$"
    ).unwrap()
});

pub(crate) fn read_and_decode(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;

    // BOM detection takes priority
    if bytes.starts_with(b"\xef\xbb\xbf") {
        return String::from_utf8(bytes[3..].to_vec())
            .map_err(|e| format!("UTF-8 BOM file invalid: {e}"));
    }
    if bytes.starts_with(b"\xff\xfe") {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return Ok(text.into_owned());
    }
    if bytes.starts_with(b"\xfe\xff") {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return Ok(text.into_owned());
    }

    // Otherwise sniff; chardetng is tuned for CJK content
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, _) = encoding.decode(&bytes);
    Ok(text.into_owned())
}

#[derive(Clone)]
pub(crate) struct TxtChapter {
    pub label: String,
    pub content: String,
}

pub(crate) fn split_into_chapters(text: &str) -> Vec<TxtChapter> {
    let matches: Vec<_> = CHAPTER_RE.find_iter(text).collect();
    if matches.is_empty() {
        return vec![TxtChapter {
            label: "全文".to_string(),
            content: text.to_string(),
        }];
    }

    let mut chapters = Vec::new();

    // Include any substantial preamble before the first chapter heading
    let first_start = matches[0].start();
    if first_start > 0 {
        let prefix = text[..first_start].trim();
        if prefix.chars().count() > 200 {
            chapters.push(TxtChapter {
                label: "开篇".to_string(),
                content: prefix.to_string(),
            });
        }
    }

    for (i, m) in matches.iter().enumerate() {
        let start = m.start();
        let end = matches
            .get(i + 1)
            .map(|next| next.start())
            .unwrap_or(text.len());
        chapters.push(TxtChapter {
            label: m.as_str().trim().to_string(),
            content: text[start..end].to_string(),
        });
    }

    chapters
}

fn render_html(content: &str) -> String {
    let mut out = String::with_capacity(content.len() + 100);
    let mut first = true;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if first {
            // Treat the first non-empty line as the chapter title
            out.push_str("<h2>");
            out.push_str(&escape_html(trimmed));
            out.push_str("</h2>");
            first = false;
        } else {
            out.push_str("<p>");
            out.push_str(&escape_html(trimmed));
            out.push_str("</p>");
        }
    }
    out
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

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

#[tauri::command]
pub fn read_txt_initial(path: String) -> Result<EpubPreview, String> {
    read_txt_chapter(path, 0)
}

#[tauri::command]
pub fn read_txt_chapter(path: String, spine_index: usize) -> Result<EpubPreview, String> {
    let text = read_and_decode(Path::new(&path))?;
    let chapters = split_into_chapters(&text);
    let total = chapters.len();
    if spine_index >= total {
        return Err(format!(
            "spine_index {spine_index} out of range (0..{total})"
        ));
    }
    let ch = &chapters[spine_index];
    let html = render_html(&ch.content);

    Ok(EpubPreview {
        title: title_from_path(Path::new(&path)),
        author: "".to_string(),
        raw_length: ch.content.len(),
        extracted_length: html.len(),
        html,
        spine_index,
        spine_total: total,
    })
}

#[tauri::command]
pub fn get_txt_toc(path: String) -> Result<Vec<TocEntry>, String> {
    let text = read_and_decode(Path::new(&path))?;
    let chapters = split_into_chapters(&text);
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
