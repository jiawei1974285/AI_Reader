use crate::db::{Book, DoubanMetadata};
use regex::Regex;
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use std::time::Duration;

const DOUBAN_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AIreader/0.2";

pub async fn fetch_book_metadata(book: &Book) -> DoubanMetadata {
    match try_fetch_book_metadata(book).await {
        Ok(Some(found)) => found,
        Ok(None) => failed_metadata(book.id, "not_found"),
        Err(e) => {
            let mut meta = failed_metadata(book.id, "failed");
            meta.error = Some(e);
            meta
        }
    }
}

async fn try_fetch_book_metadata(book: &Book) -> Result<Option<DoubanMetadata>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let query = if book.author.trim().is_empty() || book.author == "Unknown" {
        book.title.clone()
    } else {
        format!("{} {}", book.title, book.author)
    };
    let search_url = reqwest::Url::parse_with_params(
        "https://www.douban.com/search",
        &[("q", query.trim()), ("cat", "1001")],
    )
    .map_err(|e| e.to_string())?;
    let search_html = client
        .get(search_url)
        .header(USER_AGENT, DOUBAN_UA)
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.7")
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let Some(subject_url) = find_first_book_subject_url(&search_html) else {
        return Ok(None);
    };

    let subject_html = client
        .get(&subject_url)
        .header(USER_AGENT, DOUBAN_UA)
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.7")
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    Ok(parse_subject_html(book.id, &subject_url, &subject_html))
}

pub fn failed_metadata(book_id: i64, status: &str) -> DoubanMetadata {
    DoubanMetadata {
        book_id,
        status: status.to_string(),
        rating: None,
        rating_count: None,
        summary: None,
        douban_url: None,
        fetched_at: now_ms(),
        error: None,
    }
}

pub(crate) fn find_first_book_subject_url(html: &str) -> Option<String> {
    let re = Regex::new(r#"https?://book\.douban\.com/subject/\d+/?(?:\?[^\s"'<>]*)?"#).ok()?;
    if let Some(m) = re.find(html) {
        return Some(normalize_subject_url(m.as_str()));
    }

    let link2_re = Regex::new(r#"https?://www\.douban\.com/link2/\?[^"'<>]+"#).ok()?;
    for m in link2_re.find_iter(html) {
        let raw = decode_html_entities(m.as_str());
        let Ok(url) = reqwest::Url::parse(&raw) else {
            continue;
        };
        let Some(target) = url
            .query_pairs()
            .find_map(|(k, v)| (k == "url").then(|| v.into_owned()))
        else {
            continue;
        };
        if re.is_match(&target) {
            return Some(normalize_subject_url(&target));
        }
    }
    None
}

pub(crate) fn parse_subject_html(
    book_id: i64,
    subject_url: &str,
    html: &str,
) -> Option<DoubanMetadata> {
    let rating = capture_text(
        html,
        r#"(?s)<[^>]*class=["'][^"']*rating_num[^"']*["'][^>]*>(.*?)</[^>]+>"#,
    )
    .filter(|s| !s.is_empty());
    let rating_count =
        capture_text(html, r#"<span[^>]+property=["']v:votes["'][^>]*>(?s:(.*?))</span>"#)
            .and_then(|s| s.replace(',', "").parse::<i64>().ok());
    let summary = extract_summary(html);

    if rating.is_none() && rating_count.is_none() && summary.is_none() {
        return None;
    }

    Some(DoubanMetadata {
        book_id,
        status: "ok".to_string(),
        rating,
        rating_count,
        summary,
        douban_url: Some(subject_url.to_string()),
        fetched_at: now_ms(),
        error: None,
    })
}

fn normalize_subject_url(url: &str) -> String {
    let base = url.split('?').next().unwrap_or(url);
    if base.ends_with('/') {
        base.to_string()
    } else {
        format!("{base}/")
    }
}

fn extract_summary(html: &str) -> Option<String> {
    let hidden = capture_html(
        html,
        r#"<span[^>]+class=["'][^"']*all\s+hidden[^"']*["'][^>]*>(?s:(.*?))</span>"#,
    );
    let link_report = capture_html(html, r#"<div[^>]+id=["']link-report["'][^>]*>(?s:(.*?))</div>"#);
    let raw = hidden.or(link_report)?;
    let text = html_to_text(&raw);
    if text.is_empty() {
        None
    } else {
        Some(text.chars().take(420).collect())
    }
}

fn capture_text(html: &str, pattern: &str) -> Option<String> {
    capture_html(html, pattern).map(|s| html_to_text(&s))
}

fn capture_html(html: &str, pattern: &str) -> Option<String> {
    let re = Regex::new(pattern).ok()?;
    re.captures(html)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
}

fn html_to_text(html: &str) -> String {
    let without_noise = Regex::new(
        r"(?is)<script[^>]*>.*?</script>|<style[^>]*>.*?</style>|<noscript[^>]*>.*?</noscript>",
    )
        .map(|re| re.replace_all(html, "").into_owned())
        .unwrap_or_else(|_| html.to_string());
    let with_breaks = Regex::new(r"(?i)</p>|<br\s*/?>")
        .map(|re| re.replace_all(&without_noise, "\n").into_owned())
        .unwrap_or(without_noise);
    let no_tags = Regex::new(r"(?s)<[^>]+>")
        .map(|re| re.replace_all(&with_breaks, "").into_owned())
        .unwrap_or(with_breaks);
    decode_html_entities(&no_tags)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_first_book_subject_from_search_html() {
        let html = r#"
            <div class="result">
              <a href="https://movie.douban.com/subject/1/">wrong</a>
              <a href="https://book.douban.com/subject/33424487/">Book</a>
            </div>
        "#;

        assert_eq!(
            find_first_book_subject_url(html).as_deref(),
            Some("https://book.douban.com/subject/33424487/")
        );
    }

    #[test]
    fn parses_book_subject_from_douban_link2_search_html() {
        let html = r#"
            <div class="result">
              <a class="nbg" href="https://www.douban.com/link2/?url=https%3A%2F%2Fbook.douban.com%2Fsubject%2F2567698%2F&amp;query=%E4%B8%89%E4%BD%93&amp;cat_id=1001">Book</a>
            </div>
        "#;

        assert_eq!(
            find_first_book_subject_url(html).as_deref(),
            Some("https://book.douban.com/subject/2567698/")
        );
    }

    #[test]
    fn parses_rating_votes_intro_and_link_from_subject_html() {
        let html = r#"
            <html>
              <span class="rating_num" property="v:average"> 8.7 </span>
              <span property="v:votes">12345</span>
              <div id="link-report">
                <span class="all hidden">
                  <div class="intro">
                    <p>第一段简介。</p>
                    <p>第二段简介。</p>
                  </div>
                </span>
              </div>
            </html>
        "#;

        let meta = parse_subject_html(42, "https://book.douban.com/subject/33424487/", html)
            .expect("metadata should parse");

        assert_eq!(meta.book_id, 42);
        assert_eq!(meta.status, "ok");
        assert_eq!(meta.rating.as_deref(), Some("8.7"));
        assert_eq!(meta.rating_count, Some(12345));
        assert_eq!(meta.summary.as_deref(), Some("第一段简介。\n第二段简介。"));
        assert_eq!(
            meta.douban_url.as_deref(),
            Some("https://book.douban.com/subject/33424487/")
        );
    }

    #[test]
    fn parses_strong_rating_from_current_subject_html() {
        let html = r#"
            <html>
              <strong class="ll rating_num " property="v:average"> 8.9 </strong>
              <a href="comments" class="rating_people"><span property="v:votes">515613</span>人评价</a>
              <div class="indent" id="link-report"><div class="intro"><p>简介正文</p></div></div>
            </html>
        "#;

        let meta = parse_subject_html(7, "https://book.douban.com/subject/2567698/", html)
            .expect("metadata should parse");

        assert_eq!(meta.rating.as_deref(), Some("8.9"));
        assert_eq!(meta.rating_count, Some(515613));
    }

    #[test]
    fn summary_ignores_embedded_style_blocks() {
        let html = r#"
            <html>
              <strong class="ll rating_num " property="v:average"> 8.0 </strong>
              <div id="link-report">
                <style>.intro p{text-indent:2em;word-break:normal;}</style>
                <div class="intro">
                  <p>希望三国演义的故事在中国永远流传。</p>
                </div>
              </div>
            </html>
        "#;

        let meta = parse_subject_html(8, "https://book.douban.com/subject/1/", html)
            .expect("metadata should parse");

        assert_eq!(
            meta.summary.as_deref(),
            Some("希望三国演义的故事在中国永远流传。")
        );
    }
}
