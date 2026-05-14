use pulldown_cmark::{CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

const MAX_INLINE_IMAGE_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct OutlineItem {
    pub level: u8,
    pub text: String,
    pub anchor: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RenderResult {
    pub html: String,
    pub outline: Vec<OutlineItem>,
    pub words: usize,
    #[serde(rename = "readingMinutes")]
    pub reading_minutes: u32,
}

fn syntax_set() -> &'static SyntaxSet {
    static S: OnceLock<SyntaxSet> = OnceLock::new();
    S.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            for c in ch.to_lowercase() {
                out.push(c);
            }
            last_dash = false;
        } else if (ch.is_whitespace() || ch == '-' || ch == '_') && !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("section");
    }
    out
}

fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn highlight_code(code: &str, lang: &str) -> String {
    let ss = syntax_set();
    let syntax = if lang.is_empty() {
        ss.find_syntax_plain_text()
    } else {
        ss.find_syntax_by_token(lang)
            .or_else(|| ss.find_syntax_by_name(lang))
            .unwrap_or_else(|| ss.find_syntax_plain_text())
    };
    let mut generator = ClassedHTMLGenerator::new_with_class_style(syntax, ss, ClassStyle::Spaced);
    for line in LinesWithEndings::from(code) {
        let _ = generator.parse_html_for_line_which_includes_newline(line);
    }
    let html = generator.finalize();
    format!(
        "<pre class=\"hljs\" data-lang=\"{lang_attr}\"><code class=\"language-{lang_attr}\">{html}</code></pre>",
        lang_attr = escape_attr(lang),
        html = html
    )
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn is_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("mailto:")
        || lower.starts_with('#')
        || lower.contains("://")
}

fn percent_decode_path(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn local_image_data_url(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_INLINE_IMAGE_SIZE {
        return None;
    }
    let mime = image_mime(path)?;
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn resolve_local_image_url(
    dest: &str,
    base_path: Option<&Path>,
    allowed_roots: &[PathBuf],
) -> Option<String> {
    if is_external_url(dest) || dest.starts_with('/') || dest.starts_with('\\') {
        return None;
    }
    let base_path = base_path?;
    let base_dir = if base_path.is_dir() {
        base_path
    } else {
        base_path.parent()?
    };
    let path_part = dest.split(['?', '#']).next().unwrap_or(dest);
    if path_part.trim().is_empty() {
        return None;
    }
    let decoded = percent_decode_path(path_part);
    let canon = base_dir.join(decoded).canonicalize().ok()?;
    if allowed_roots.iter().any(|root| canon.starts_with(root)) {
        local_image_data_url(&canon)
    } else {
        None
    }
}

fn rewrite_asset_event<'a>(
    ev: Event<'a>,
    base_path: Option<&Path>,
    allowed_roots: &[PathBuf],
) -> Event<'a> {
    match ev {
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            if let Some(url) = resolve_local_image_url(&dest_url, base_path, allowed_roots) {
                Event::Start(Tag::Image {
                    link_type,
                    dest_url: CowStr::Boxed(url.into_boxed_str()),
                    title,
                    id,
                })
            } else {
                Event::Start(Tag::Image {
                    link_type,
                    dest_url,
                    title,
                    id,
                })
            }
        }
        _ => ev,
    }
}

fn parser_options() -> Options {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_SMART_PUNCTUATION);
    opts.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    opts.insert(Options::ENABLE_MATH);
    opts.insert(Options::ENABLE_GFM);
    opts
}

fn level_u8(l: HeadingLevel) -> u8 {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// 把 pulldown 输出的 HTML 走一次 ammonia 清洗，移除 script / iframe / on* 事件
/// 与 javascript: 协议。即使 markdown 里硬塞 raw HTML 也被裁掉。
fn sanitize(html: &str) -> String {
    use ammonia::{Builder, UrlRelative};
    let mut b = Builder::default();
    b.add_url_schemes(&["data"]);
    b.add_tags(&[
        "span",
        "mark",
        "div",
        "input",
        "section",
        "article",
        "details",
        "summary",
        "figure",
        "figcaption",
    ]);
    b.add_generic_attributes(&["class", "id", "data-lang", "data-mermaid", "data-line"]);
    b.add_tag_attributes("input", &["type", "checked", "disabled"]);
    // 注意 ammonia 自己控制 <a rel>，写进来会 panic
    b.add_tag_attributes("a", &["href", "title", "target", "id"]);
    b.add_tag_attributes("img", &["src", "alt", "title", "width", "height"]);
    // 防止相对 URL 被改写到任意路径
    b.url_relative(UrlRelative::PassThrough);
    b.clean(html).to_string()
}

/// 主渲染入口
pub fn render(source: &str, base_path: Option<&Path>, allowed_roots: &[PathBuf]) -> RenderResult {
    let parser = Parser::new_ext(source, parser_options());
    let mut html = String::new();
    let mut outline: Vec<OutlineItem> = Vec::new();

    let mut heading: Option<(u8, String)> = None;
    let mut heading_events: Vec<Event> = Vec::new();

    let mut code_buf = String::new();
    let mut code_lang = String::new();
    let mut in_code = false;
    let mut id_counter: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

    let mut buffer: Vec<Event> = Vec::with_capacity(16);

    let flush = |buf: &mut Vec<Event>, html: &mut String| {
        if buf.is_empty() {
            return;
        }
        let mut piece = String::new();
        pulldown_cmark::html::push_html(&mut piece, buf.drain(..));
        html.push_str(&piece);
    };

    for ev in parser {
        let ev = rewrite_asset_event(ev, base_path, allowed_roots);
        if let Some((_lvl, _)) = heading.as_mut() {
            match &ev {
                Event::End(TagEnd::Heading(level)) => {
                    let Some((lvl, text)) = heading.take() else {
                        continue;
                    };
                    let _ = lvl;
                    let mut anchor = slugify(&text);
                    let cnt = id_counter.entry(anchor.clone()).or_insert(0);
                    if *cnt > 0 {
                        anchor = format!("{}-{}", anchor, *cnt + 1);
                    }
                    *cnt += 1;
                    let lvl_u8 = level_u8(*level);
                    outline.push(OutlineItem {
                        level: lvl_u8,
                        text: text.clone(),
                        anchor: anchor.clone(),
                    });
                    let mut inner = String::new();
                    pulldown_cmark::html::push_html(&mut inner, heading_events.drain(..));
                    html.push_str(&format!(
                        "<h{l} id=\"{a}\">{i}</h{l}>",
                        l = lvl_u8,
                        a = escape_attr(&anchor),
                        i = inner
                    ));
                }
                Event::Text(t) => {
                    if let Some((_, s)) = heading.as_mut() {
                        s.push_str(t);
                    }
                    heading_events.push(ev);
                }
                Event::Code(c) => {
                    if let Some((_, s)) = heading.as_mut() {
                        s.push_str(c);
                    }
                    heading_events.push(ev);
                }
                _ => heading_events.push(ev),
            }
            continue;
        }
        if in_code {
            match &ev {
                Event::Text(t) => code_buf.push_str(t),
                Event::End(TagEnd::CodeBlock) => {
                    in_code = false;
                    let lang = code_lang.to_lowercase();
                    if lang == "mermaid" {
                        html.push_str(&format!(
                            "<div class=\"mermaid-block\" data-mermaid=\"{}\">{}</div>",
                            urlencode(&code_buf),
                            escape_html(&code_buf)
                        ));
                    } else {
                        html.push_str(&highlight_code(&code_buf, &lang));
                    }
                    code_buf.clear();
                    code_lang.clear();
                }
                _ => {}
            }
            continue;
        }
        match &ev {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut buffer, &mut html);
                heading = Some((level_u8(*level), String::new()));
                heading_events.clear();
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush(&mut buffer, &mut html);
                in_code = true;
                code_buf.clear();
                code_lang.clear();
                if let CodeBlockKind::Fenced(info) = kind {
                    code_lang = info.split_whitespace().next().unwrap_or("").to_string();
                }
            }
            _ => buffer.push(ev),
        }
    }
    flush(&mut buffer, &mut html);

    let words = count_words(source);
    let reading_minutes = ((words as f32 / 220.0).ceil() as u32).max(1);
    let html = sanitize(&html);

    RenderResult {
        html,
        outline,
        words,
        reading_minutes,
    }
}

pub fn outline_only(source: &str) -> Vec<OutlineItem> {
    let parser = Parser::new_ext(source, parser_options());
    let mut out: Vec<OutlineItem> = Vec::new();
    let mut cur: Option<HeadingLevel> = None;
    let mut buf = String::new();
    let mut id_counter: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for ev in parser {
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                cur = Some(level);
                buf.clear();
            }
            Event::Text(t) if cur.is_some() => buf.push_str(&t),
            Event::Code(c) if cur.is_some() => buf.push_str(&c),
            Event::End(TagEnd::Heading(level)) => {
                let lvl = level_u8(level);
                let mut anchor = slugify(&buf);
                let cnt = id_counter.entry(anchor.clone()).or_insert(0);
                if *cnt > 0 {
                    anchor = format!("{}-{}", anchor, *cnt + 1);
                }
                *cnt += 1;
                out.push(OutlineItem {
                    level: lvl,
                    text: buf.clone(),
                    anchor,
                });
                cur = None;
            }
            _ => {}
        }
    }
    out
}

pub fn count_words(src: &str) -> usize {
    let mut count = 0usize;
    let mut last_alpha = false;
    for ch in src.chars() {
        let is_cjk = matches!(ch as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF |
            0x3040..=0x30FF | 0xAC00..=0xD7AF);
        if is_cjk {
            count += 1;
            last_alpha = false;
        } else if ch.is_alphanumeric() {
            if !last_alpha {
                count += 1;
            }
            last_alpha = true;
        } else {
            last_alpha = false;
        }
    }
    count
}

pub fn metadata_only(source: &str) -> (Vec<OutlineItem>, usize, u32) {
    let outline = outline_only(source);
    let words = count_words(source);
    let reading_minutes = ((words as f32 / 220.0).ceil() as u32).max(1);
    (outline, words, reading_minutes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outline_extracts_headings_with_anchors() {
        let src = "# Title\n\n## Section A\n\ntext\n\n## Section B\n";
        let items = outline_only(src);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].level, 1);
        assert_eq!(items[0].text, "Title");
        assert_eq!(items[1].text, "Section A");
        assert_eq!(items[2].text, "Section B");
        // anchor 唯一
        let a = &items[1].anchor;
        let b = &items[2].anchor;
        assert_ne!(a, b);
    }

    #[test]
    fn outline_skips_headings_in_code_fence() {
        let src = "# Real\n\n```\n# Not a heading\n```\n";
        let items = outline_only(src);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Real");
    }

    #[test]
    fn slugify_basic_cases() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("Test 123"), "test-123");
        assert_eq!(slugify("中文标题"), "中文标题");
        // 连续空格折叠
        assert_eq!(slugify("a   b"), "a-b");
    }

    #[test]
    fn render_returns_html_and_outline() {
        let res = render("# Hello\n\nworld", None, &[]);
        assert!(res.html.contains("<h1"));
        assert!(res.html.contains("Hello"));
        assert_eq!(res.outline.len(), 1);
        assert!(res.words > 0);
    }
}
