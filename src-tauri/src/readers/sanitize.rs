//! HTML 清洗。EPUB / MOBI 抽出来的章节正文是任意第三方提供的 HTML，
//! 直接喂前端 `dangerouslySetInnerHTML` 是个攻击面：
//!
//! - `<script>` 直接执行（可调 fetch 把笔记发到外部）
//! - `<img onerror="...">` 等 on* 事件属性
//! - `<a href="javascript:...">`
//! - `<iframe>` / `<object>` / `<embed>` 嵌入外部内容
//! - `<form>` 钓鱼
//! - `<style>` / `<link>` 覆盖应用主题
//!
//! 之前 `epub.rs::strip_visual` 用正则去 `<script>/<style>/<link>`，
//! 漏 on* 事件、javascript: URL、iframe 等。换成 ammonia（html5ever
//! 真正解析 + 白名单），一次性堵死整个攻击面（CLAUDE.md 原则 14 冗余兜底）。
//!
//! 仍然允许：
//! - 常规排版标签（p/h1-6/div/span/em/strong/b/i/u/blockquote/...）
//! - `<img>` 但 src 必须是 `data:` URI（`epub::inline_images` 已把
//!   章节内的图都转 base64，不再依赖外部 URL）
//! - `<svg>` + `<image>`（带 data: URI 的内联图常见在插图本里）
//! - `<a href="http(s)://..." | "mailto:..." | "#..."`
//! - `class` 属性（reader 主题 CSS 可能挂钩）
//!
//! 不允许：
//! - `style` 属性（避免书内 CSS 覆盖应用主题；EPUB 排版细节由 reader 设置统一管）
//! - 任何 on* 属性
//! - `javascript:` / `vbscript:` / `file:` URL

use ammonia::Builder;
use std::collections::HashSet;
use std::sync::LazyLock;

static SANITIZER: LazyLock<Builder<'static>> = LazyLock::new(make_builder);

fn make_builder() -> Builder<'static> {
    let mut b = Builder::default();

    // URL schemes：data 是为内联图，http/https/mailto 是给章末引用，
    // tel/anchor (#) 默认就支持。javascript / vbscript / file 一律不允许。
    let mut schemes: HashSet<&'static str> = HashSet::new();
    schemes.insert("http");
    schemes.insert("https");
    schemes.insert("data");
    schemes.insert("mailto");
    schemes.insert("tel");
    b.url_schemes(schemes);

    // SVG + image：插图本常见 <svg viewBox><image xlink:href="data:..."/>，
    // ammonia 默认不允许 SVG 命名空间，要显式加。
    let mut extra_tags: HashSet<&'static str> = HashSet::new();
    extra_tags.insert("svg");
    extra_tags.insert("image");
    extra_tags.insert("g");
    extra_tags.insert("title");
    b.add_tags(extra_tags);

    // class 给主题 CSS 挂钩用
    let mut generic_attrs: HashSet<&'static str> = HashSet::new();
    generic_attrs.insert("class");
    generic_attrs.insert("id");
    b.add_generic_attributes(generic_attrs);

    // img 属性（src 限制由 url_schemes 卡住，非 data: 的 http URL
    // 也允许，但 epub::inline_images 实际上已经把所有 <img> 转成 data:）
    b.add_tag_attributes("img", ["src", "alt", "width", "height", "title"]);
    b.add_tag_attributes(
        "image",
        ["src", "href", "xlink:href", "width", "height", "x", "y"],
    );
    b.add_tag_attributes("svg", ["viewBox", "width", "height", "xmlns"]);

    // 表格列宽
    b.add_tag_attributes("td", ["colspan", "rowspan"]);
    b.add_tag_attributes("th", ["colspan", "rowspan"]);

    // 链接 target="_blank" 时强制带 noopener noreferrer
    b.link_rel(Some("noopener noreferrer"));

    b
}

/// 清洗一段第三方 HTML，返回前端可直接 `dangerouslySetInnerHTML` 渲染的安全 HTML。
pub fn clean(html: &str) -> String {
    SANITIZER.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn strips_script_tag() {
        let dirty = r#"<p>hi</p><script>alert(1)</script>"#;
        let out = clean(dirty);
        assert!(out.contains("<p>hi</p>"));
        assert!(!out.contains("script"));
        assert!(!out.contains("alert"));
    }

    #[test]
    fn strips_onerror_attribute() {
        let dirty = r#"<img src="data:image/png;base64,iVBOR" onerror="fetch('http://evil')" alt="x">"#;
        let out = clean(dirty);
        assert!(out.contains("data:image/png"));
        assert!(!out.contains("onerror"));
        assert!(!out.contains("fetch"));
    }

    #[test]
    fn strips_javascript_url() {
        let dirty = r#"<a href="javascript:alert(1)">click</a>"#;
        let out = clean(dirty);
        assert!(!out.contains("javascript:"));
        // ammonia 会把不合法的 href 去掉，但保留 anchor 文本
        assert!(out.contains("click"));
    }

    #[test]
    fn strips_iframe() {
        let dirty = r#"<p>before</p><iframe src="http://evil"></iframe><p>after</p>"#;
        let out = clean(dirty);
        assert!(out.contains("before"));
        assert!(out.contains("after"));
        assert!(!out.contains("iframe"));
        assert!(!out.contains("evil"));
    }

    #[test]
    fn strips_style_attribute_but_keeps_content() {
        let dirty = r#"<p style="background:url(http://evil)">text</p>"#;
        let out = clean(dirty);
        assert!(out.contains("text"));
        assert!(!out.contains("style"));
        assert!(!out.contains("evil"));
    }

    #[test]
    fn strips_form() {
        let dirty = r#"<form action="http://evil"><input name="api_key"/></form>"#;
        let out = clean(dirty);
        assert!(!out.contains("form"));
        assert!(!out.contains("input"));
        assert!(!out.contains("evil"));
    }

    #[test]
    fn preserves_normal_typography() {
        let dirty = r#"<p>第一段</p><h2>标题</h2><blockquote>引用</blockquote><em>强调</em>"#;
        let out = clean(dirty);
        assert!(out.contains("第一段"));
        assert!(out.contains("标题"));
        assert!(out.contains("引用"));
        assert!(out.contains("强调"));
    }

    #[test]
    fn preserves_svg_with_inline_image() {
        let dirty = r#"<svg viewBox="0 0 100 100"><image xlink:href="data:image/png;base64,AAA" width="100" height="100"/></svg>"#;
        let out = clean(dirty);
        // svg + image 标签保留 + xlink:href 的 data: URI 保留
        assert!(out.contains("svg"));
        assert!(out.contains("data:image/png"));
    }
}
