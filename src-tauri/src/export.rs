//! C10 — 把一本书的高亮 / 笔记导出成可分享 / 可往别处灌的格式。
//!
//! 目前两种：
//!   - EPUB：手写最小合规 EPUB 3 包 (mimetype + container.xml + content.opf
//!     + nav.xhtml + chapter.xhtml + zip 打包)。能用 Calibre / Apple Books /
//!     绝大多数阅读器打开。
//!   - CSV：Anki 直接导入的格式，front = 高亮原文，back = 出处 + 笔记。
//!
//! 设计选择 (CLAUDE.md 原则 14 冗余兜底): 不引入 epub 写库依赖，手写
//! zip 即可——格式规范一目了然，将来要改样式 / 加章节切分都改这一个文件。

use crate::db::HighlightWithBook;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

/// 把 `highlights` 导出为一个 EPUB 文件。每条高亮一段 blockquote + 可选 note。
/// 用户通常一本书一次性导出，所以全部高亮归到一个 chapter；如果未来要
/// 按原书章节分 chapter 再说。
pub fn export_to_epub(
    output_path: &Path,
    book_title: &str,
    book_author: &str,
    highlights: &[HighlightWithBook],
) -> Result<(), String> {
    let file = File::create(output_path).map_err(|e| format!("创建输出文件失败: {e}"))?;
    let mut zip = ZipWriter::new(file);

    // mimetype 必须第一项且 Stored (不压缩) — EPUB 规范要求
    zip.start_file::<_, ()>(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .map_err(|e| format!("zip: {e}"))?;
    zip.write_all(b"application/epub+zip")
        .map_err(|e| format!("write: {e}"))?;

    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // META-INF/container.xml — 告诉 reader 主 OPF 在哪
    zip.start_file::<_, ()>("META-INF/container.xml", opts)
        .map_err(|e| format!("zip: {e}"))?;
    zip.write_all(CONTAINER_XML.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    // OEBPS/content.opf — package metadata + manifest + spine
    zip.start_file::<_, ()>("OEBPS/content.opf", opts)
        .map_err(|e| format!("zip: {e}"))?;
    let opf = make_content_opf(book_title, book_author);
    zip.write_all(opf.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    // OEBPS/nav.xhtml — EPUB 3 nav document（TOC）
    zip.start_file::<_, ()>("OEBPS/nav.xhtml", opts)
        .map_err(|e| format!("zip: {e}"))?;
    zip.write_all(NAV_XHTML.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    // OEBPS/clippings.xhtml — 正文
    zip.start_file::<_, ()>("OEBPS/clippings.xhtml", opts)
        .map_err(|e| format!("zip: {e}"))?;
    let body = make_clippings_xhtml(book_title, book_author, highlights);
    zip.write_all(body.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(())
}

/// CSV 导出 — Anki 可直接导入 (Front, Back, BookTitle, Chapter, Color)
pub fn export_to_csv(
    output_path: &Path,
    highlights: &[HighlightWithBook],
) -> Result<(), String> {
    let mut buf = String::new();
    buf.push_str("front,back,book_title,chapter,color\n");
    for h in highlights {
        let front = csv_escape(&h.selected_text);
        let chapter_label = format!("第 {} 章", h.spine_index + 1);
        let back = if h.note.trim().is_empty() {
            format!("《{}》— {}", h.book_title, chapter_label)
        } else {
            format!("《{}》— {} — 笔记: {}", h.book_title, chapter_label, h.note)
        };
        buf.push_str(&format!(
            "{},{},{},{},{}\n",
            front,
            csv_escape(&back),
            csv_escape(&h.book_title),
            csv_escape(&chapter_label),
            csv_escape(&h.color),
        ));
    }
    std::fs::write(output_path, buf.as_bytes())
        .map_err(|e| format!("写 CSV 失败: {e}"))?;
    Ok(())
}

fn csv_escape(s: &str) -> String {
    let needs_quote = s.contains(',') || s.contains('"') || s.contains('\n');
    if !needs_quote {
        return s.to_string();
    }
    let escaped = s.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

const NAV_XHTML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="clippings.xhtml">我的高亮与笔记</a></li>
    </ol>
  </nav>
</body>
</html>
"#;

fn make_content_opf(title: &str, author: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">aireader-clippings-{ts}</dc:identifier>
    <dc:title>{title} — 我的高亮</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">{ts}T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="clip" href="clippings.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="clip"/>
  </spine>
</package>
"#,
        title = xml_escape(title),
        author = xml_escape(author),
        ts = chrono_today(),
    )
}

fn make_clippings_xhtml(
    title: &str,
    author: &str,
    highlights: &[HighlightWithBook],
) -> String {
    let mut body = String::new();
    body.push_str(&format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>{} — 我的高亮</title>
  <style>
    body {{ font-family: serif; line-height: 1.7; padding: 1.5em; max-width: 36em; margin: 0 auto; }}
    h1 {{ font-size: 1.6em; border-bottom: 2px solid #888; padding-bottom: 0.3em; }}
    h2 {{ font-size: 1.1em; color: #555; margin-top: 2em; }}
    blockquote {{ border-left: 4px solid #aaa; margin: 0.6em 0; padding: 0.4em 1em;
                  background: rgba(0,0,0,0.04); }}
    .note {{ color: #444; font-style: italic; margin-left: 1em; font-size: 0.95em; }}
    .meta {{ color: #999; font-size: 0.8em; margin-top: 0.2em; }}
    .c-yellow {{ border-left-color: #facc15; }}
    .c-green  {{ border-left-color: #84cc5a; }}
    .c-blue   {{ border-left-color: #60a5fa; }}
    .c-red    {{ border-left-color: #fc645a; }}
  </style>
</head>
<body>
  <h1>{}</h1>
  <p class="meta">作者: {} · 共 {} 条标注</p>
"#,
        xml_escape(title),
        xml_escape(title),
        xml_escape(author),
        highlights.len(),
    ));

    // 按章节分组
    let mut current_spine: i64 = -1;
    for h in highlights {
        if h.spine_index != current_spine {
            body.push_str(&format!(
                "  <h2>第 {} 章</h2>\n",
                h.spine_index + 1
            ));
            current_spine = h.spine_index;
        }
        body.push_str(&format!(
            "  <blockquote class=\"c-{}\">{}</blockquote>\n",
            xml_escape(&h.color),
            xml_escape(&h.selected_text),
        ));
        if !h.note.trim().is_empty() {
            body.push_str(&format!(
                "  <p class=\"note\">笔记：{}</p>\n",
                xml_escape(&h.note),
            ));
        }
    }

    body.push_str("</body>\n</html>\n");
    body
}

/// 不引入 chrono crate；只要 ISO 日期粗略对就行。
fn chrono_today() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // 简化：epoch_ms → 自 1970 来的天数 → YYYY-MM-DD
    let days = ms / 86_400_000;
    // 从 1970-01-01 起算，使用 Howard Hinnant 的日期算法（civil_from_days）
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Howard Hinnant 算法: epoch days → (year, month, day). UTC.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_hl(book_title: &str, spine: i64, text: &str, note: &str) -> HighlightWithBook {
        HighlightWithBook {
            id: 1,
            book_id: 1,
            spine_index: spine,
            selected_text: text.into(),
            prefix: "".into(),
            suffix: "".into(),
            color: "yellow".into(),
            note: note.into(),
            created_at: 0,
            updated_at: 0,
            book_title: book_title.into(),
            book_author: "A".into(),
            book_format: "epub".into(),
        }
    }

    #[test]
    fn csv_escape_handles_comma_quote_newline() {
        assert_eq!(csv_escape("hi"), "hi");
        assert_eq!(csv_escape("a,b"), r#""a,b""#);
        assert_eq!(csv_escape(r#"a"b"#), r#""a""b""#);
        assert_eq!(csv_escape("line1\nline2"), "\"line1\nline2\"");
    }

    #[test]
    fn xml_escape_blocks_injection() {
        assert_eq!(xml_escape("a<b>c"), "a&lt;b&gt;c");
        assert_eq!(xml_escape(r#"a&b"c'd"#), "a&amp;b&quot;c&apos;d");
    }

    #[test]
    fn clippings_xhtml_groups_by_chapter() {
        let hs = vec![
            mk_hl("Book", 0, "first quote", ""),
            mk_hl("Book", 0, "second quote", "with note"),
            mk_hl("Book", 2, "third quote", ""),
        ];
        let out = make_clippings_xhtml("Book", "Author", &hs);
        // 两个章节标题（第 1 章 / 第 3 章）
        assert!(out.contains("第 1 章"));
        assert!(out.contains("第 3 章"));
        // 三条 blockquote
        assert_eq!(out.matches("<blockquote").count(), 3);
        // note 被渲染
        assert!(out.contains("with note"));
    }

    #[test]
    fn civil_from_days_known_epoch() {
        // day 0 = 1970-01-01
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // day 365 = 1971-01-01
        assert_eq!(civil_from_days(365), (1971, 1, 1));
    }
}
