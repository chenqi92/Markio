use pulldown_cmark::{CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

const MAX_INLINE_IMAGE_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
struct CodeInfo {
    lang: String,
    title: Option<String>,
    highlight_lines: Option<String>,
    server: Option<String>,
}

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

fn parse_attr_value(input: &str, key: &str) -> Option<String> {
    let start = input.find(&format!("{key}="))?;
    let mut rest = input[start + key.len() + 1..].trim_start();
    if rest.is_empty() {
        return None;
    }
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        return Some(stripped[..end].to_string());
    }
    if let Some(stripped) = rest.strip_prefix('\'') {
        let end = stripped.find('\'')?;
        return Some(stripped[..end].to_string());
    }
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    rest = &rest[..end];
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

fn parse_highlight_lines(input: &str) -> Option<String> {
    let start = input.find('{')?;
    let end = input[start + 1..].find('}')? + start + 1;
    let spec = input[start + 1..end].trim();
    if spec.is_empty()
        || !spec
            .chars()
            .all(|c| c.is_ascii_digit() || c == ',' || c == '-' || c.is_whitespace())
    {
        return None;
    }
    Some(spec.to_string())
}

fn parse_code_info(info: &str) -> CodeInfo {
    let trimmed = info.trim();
    if trimmed.is_empty() {
        return CodeInfo::default();
    }
    let first = trimmed.split_whitespace().next().unwrap_or("");
    let lang = if first.starts_with('{') || first.contains('=') {
        String::new()
    } else {
        first.to_ascii_lowercase()
    };
    CodeInfo {
        lang,
        title: parse_attr_value(trimmed, "title")
            .or_else(|| parse_attr_value(trimmed, "file"))
            .or_else(|| parse_attr_value(trimmed, "filename")),
        highlight_lines: parse_highlight_lines(trimmed),
        server: parse_attr_value(trimmed, "server"),
    }
}

fn highlight_code(code: &str, info: &CodeInfo) -> String {
    let ss = syntax_set();
    let syntax = if info.lang.is_empty() {
        ss.find_syntax_plain_text()
    } else {
        ss.find_syntax_by_token(&info.lang)
            .or_else(|| ss.find_syntax_by_name(&info.lang))
            .unwrap_or_else(|| ss.find_syntax_plain_text())
    };
    let mut generator = ClassedHTMLGenerator::new_with_class_style(syntax, ss, ClassStyle::Spaced);
    for line in LinesWithEndings::from(code) {
        let _ = generator.parse_html_for_line_which_includes_newline(line);
    }
    let html = generator.finalize();
    let title_attr = info
        .title
        .as_ref()
        .map(|title| format!(" data-title=\"{}\"", escape_attr(title)))
        .unwrap_or_default();
    let highlight_attr = info
        .highlight_lines
        .as_ref()
        .map(|lines| format!(" data-highlight-lines=\"{}\"", escape_attr(lines)))
        .unwrap_or_default();
    format!(
        "<pre class=\"hljs\" data-lang=\"{lang_attr}\"{title_attr}{highlight_attr}><code class=\"language-{lang_attr}\">{html}</code></pre>",
        lang_attr = escape_attr(&info.lang),
        html = html
    )
}

fn is_chart_lang(lang: &str) -> bool {
    matches!(lang, "chart" | "markio-chart" | "charts")
}

fn is_graphviz_lang(lang: &str) -> bool {
    matches!(lang, "dot" | "graphviz")
}

fn is_plantuml_lang(lang: &str) -> bool {
    matches!(lang, "plantuml" | "puml")
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
    b.add_generic_attributes(&[
        "class",
        "id",
        "data-lang",
        "data-title",
        "data-highlight-lines",
        "data-mermaid",
        "data-chart",
        "data-graphviz",
        "data-plantuml",
        "data-plantuml-server",
        "data-line",
    ]);
    b.add_tag_attributes("input", &["type", "checked", "disabled"]);
    // 注意 ammonia 自己控制 <a rel>，写进来会 panic
    b.add_tag_attributes("a", &["href", "title", "target", "id"]);
    b.add_tag_attributes("img", &["src", "alt", "title", "width", "height"]);
    // 防止相对 URL 被改写到任意路径
    b.url_relative(UrlRelative::PassThrough);
    b.clean(html).to_string()
}

/// 把 `data-line="N"` 注入 `piece` 中的第一个开标签。
/// 用于把 markdown 源码行号挂到对应渲染块上，供前端做行锁定滚动同步。
fn inject_data_line(piece: &mut String, line: usize) {
    let bytes = piece.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'<' && bytes[i + 1].is_ascii_alphabetic() {
            let mut j = i + 1;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b':')
            {
                j += 1;
            }
            piece.insert_str(j, &format!(" data-line=\"{}\"", line));
            return;
        }
        i += 1;
    }
}

/// 仅块级 Tag 计入嵌套深度；行内 Tag（emphasis / strong / link …）排除。
fn is_block_tag_start(tag: &Tag) -> bool {
    matches!(
        tag,
        Tag::Paragraph
            | Tag::Heading { .. }
            | Tag::BlockQuote(_)
            | Tag::CodeBlock(_)
            | Tag::HtmlBlock
            | Tag::List(_)
            | Tag::Item
            | Tag::FootnoteDefinition(_)
            | Tag::Table(_)
            | Tag::TableHead
            | Tag::TableRow
            | Tag::TableCell
            | Tag::MetadataBlock(_)
            | Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition
    )
}

fn is_block_tag_end(end: &TagEnd) -> bool {
    matches!(
        end,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::FootnoteDefinition
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
            | TagEnd::MetadataBlock(_)
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
    )
}

/// 主渲染入口
pub fn render(source: &str, base_path: Option<&Path>, allowed_roots: &[PathBuf]) -> RenderResult {
    render_with_line_offset(source, base_path, allowed_roots, 0)
}

/// 与 [`render`] 等价，但 `data-line` 全部加上 `line_offset`。流式渲染按 H1 切片
/// 后每段独立 render，行号会从 1 重新计数，前端 anchors 因此非单调、scroll sync
/// 退化。通过把段在原文中的起始行号作为偏移传入，可以让所有切片合并后的
/// data-line 在源文档坐标系里保持单调递增。
pub fn render_with_line_offset(
    source: &str,
    base_path: Option<&Path>,
    allowed_roots: &[PathBuf],
    line_offset: usize,
) -> RenderResult {
    let parser = Parser::new_ext(source, parser_options()).into_offset_iter();
    let mut html = String::new();
    let mut outline: Vec<OutlineItem> = Vec::new();

    let mut heading: Option<(u8, String)> = None;
    let mut heading_events: Vec<Event> = Vec::new();
    let mut heading_line: Option<usize> = None;

    let mut code_buf = String::new();
    let mut code_info = CodeInfo::default();
    let mut in_code = false;
    let mut code_line: Option<usize> = None;
    let mut id_counter: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

    let mut buffer: Vec<Event> = Vec::with_capacity(16);
    let mut buffer_line: Option<usize> = None;
    // Depth of *block-level* open Tags only. Inline tags (Emphasis, Strong, ...)
    // are excluded so that two sibling paragraphs flush at their boundary.
    let mut block_depth: i32 = 0;

    let flush = |buf: &mut Vec<Event>, html: &mut String, line: Option<usize>| {
        if buf.is_empty() {
            return;
        }
        let mut piece = String::new();
        pulldown_cmark::html::push_html(&mut piece, buf.drain(..));
        if let Some(ln) = line {
            inject_data_line(&mut piece, ln);
        }
        html.push_str(&piece);
    };

    for (ev, range) in parser {
        let line = source[..range.start].matches('\n').count() + 1 + line_offset;
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
                    let ln_attr = heading_line
                        .take()
                        .map(|ln| format!(" data-line=\"{}\"", ln))
                        .unwrap_or_default();
                    html.push_str(&format!(
                        "<h{l} id=\"{a}\"{ln}>{i}</h{l}>",
                        l = lvl_u8,
                        a = escape_attr(&anchor),
                        ln = ln_attr,
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
                    let ln = code_line.take();
                    let ln_attr = ln
                        .map(|n| format!(" data-line=\"{}\"", n))
                        .unwrap_or_default();
                    if code_info.lang == "mermaid" {
                        html.push_str(&format!(
                            "<div class=\"mermaid-block\" data-mermaid=\"{}\"{}>{}</div>",
                            urlencode(&code_buf),
                            ln_attr,
                            escape_html(&code_buf)
                        ));
                    } else if is_chart_lang(&code_info.lang) {
                        html.push_str(&format!(
                            "<div class=\"chart-block\" data-chart=\"{}\"{}>{}</div>",
                            urlencode(&code_buf),
                            ln_attr,
                            escape_html(&code_buf)
                        ));
                    } else if is_graphviz_lang(&code_info.lang) {
                        html.push_str(&format!(
                            "<div class=\"graphviz-block\" data-graphviz=\"{}\"{}>{}</div>",
                            urlencode(&code_buf),
                            ln_attr,
                            escape_html(&code_buf)
                        ));
                    } else if is_plantuml_lang(&code_info.lang) {
                        let server_attr = code_info
                            .server
                            .as_ref()
                            .map(|server| {
                                format!(" data-plantuml-server=\"{}\"", escape_attr(server))
                            })
                            .unwrap_or_default();
                        html.push_str(&format!(
                            "<div class=\"plantuml-block\" data-plantuml=\"{}\"{}{}>{}</div>",
                            urlencode(&code_buf),
                            server_attr,
                            ln_attr,
                            escape_html(&code_buf)
                        ));
                    } else {
                        let mut piece = highlight_code(&code_buf, &code_info);
                        if let Some(n) = ln {
                            inject_data_line(&mut piece, n);
                        }
                        html.push_str(&piece);
                    }
                    code_buf.clear();
                    code_info = CodeInfo::default();
                }
                _ => {}
            }
            continue;
        }
        match &ev {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut buffer, &mut html, buffer_line.take());
                heading = Some((level_u8(*level), String::new()));
                heading_events.clear();
                heading_line = Some(line);
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush(&mut buffer, &mut html, buffer_line.take());
                in_code = true;
                code_buf.clear();
                code_info = CodeInfo::default();
                code_line = Some(line);
                if let CodeBlockKind::Fenced(info) = kind {
                    code_info = parse_code_info(info);
                }
            }
            Event::Start(tag) => {
                if block_depth == 0 && is_block_tag_start(tag) {
                    // top-level block start: flush whatever came before and start a new piece
                    flush(&mut buffer, &mut html, buffer_line.take());
                    buffer_line = Some(line);
                }
                if is_block_tag_start(tag) {
                    block_depth += 1;
                }
                buffer.push(ev);
            }
            Event::End(end) => {
                if is_block_tag_end(end) {
                    block_depth = (block_depth - 1).max(0);
                }
                buffer.push(ev);
            }
            Event::Rule => {
                // Rule is a standalone block; treat as its own piece.
                flush(&mut buffer, &mut html, buffer_line.take());
                buffer_line = Some(line);
                buffer.push(ev);
            }
            _ => {
                // inline content (Text, Code, SoftBreak, etc.) at top level —
                // if buffer is empty (rare: bare top-level text), still record line.
                if buffer.is_empty() && buffer_line.is_none() {
                    buffer_line = Some(line);
                }
                buffer.push(ev);
            }
        }
    }
    flush(&mut buffer, &mut html, buffer_line.take());

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

    #[test]
    fn render_emits_data_line_on_top_level_blocks() {
        // line 1 heading, line 3 paragraph, line 5 list, line 9 fenced code
        let src = "# Title\n\nParagraph here.\n\n- item one\n- item two\n- item three\n\n```ts\nconst x = 1;\n```\n";
        let res = render(src, None, &[]);
        assert!(
            res.html.contains("<h1 id=\"title\" data-line=\"1\""),
            "heading missing data-line: {}",
            res.html
        );
        assert!(
            res.html.contains("<p data-line=\"3\""),
            "paragraph missing data-line: {}",
            res.html
        );
        assert!(
            res.html.contains("<ul data-line=\"5\""),
            "list missing data-line: {}",
            res.html
        );
        assert!(
            res.html.contains("<pre"),
            "code block missing pre: {}",
            res.html
        );
        assert!(
            res.html.contains("data-line=\"9\""),
            "code block missing data-line=9: {}",
            res.html
        );
    }

    #[test]
    fn render_with_line_offset_adds_to_all_data_line() {
        // 模拟流式渲染：第二段从全文第 11 行开始
        let src = "## Section\n\nbody text\n";
        let res = render_with_line_offset(src, None, &[], 10);
        assert!(
            res.html.contains("data-line=\"11\""),
            "heading data-line should be 1+10=11, got: {}",
            res.html
        );
        assert!(
            res.html.contains("data-line=\"13\""),
            "paragraph data-line should be 3+10=13, got: {}",
            res.html
        );
    }

    #[test]
    fn render_emits_data_line_on_special_blocks() {
        // mermaid / graphviz / plantuml divs also carry data-line
        let src = "para\n\n```mermaid\ngraph TD; A-->B\n```\n";
        let res = render(src, None, &[]);
        assert!(
            res.html.contains("class=\"mermaid-block\""),
            "no mermaid: {}",
            res.html
        );
        assert!(
            res.html.contains("data-line=\"3\""),
            "mermaid missing data-line=3: {}",
            res.html
        );
    }

    #[test]
    fn inject_data_line_idempotent_and_handles_void_tags() {
        let mut s = String::from("<p>hi</p>");
        inject_data_line(&mut s, 7);
        assert_eq!(s, "<p data-line=\"7\">hi</p>");

        let mut s = String::from("<hr />");
        inject_data_line(&mut s, 4);
        assert_eq!(s, "<hr data-line=\"4\" />");
    }

    #[test]
    fn render_preserves_code_block_metadata() {
        let src = "```ts title=\"src/App.tsx\" {2,4-5}\nconst a = 1;\nconsole.log(a);\n```";
        let res = render(src, None, &[]);
        assert!(res.html.contains("data-lang=\"ts\""));
        assert!(res.html.contains("data-title=\"src/App.tsx\""));
        assert!(res.html.contains("data-highlight-lines=\"2,4-5\""));
    }

    #[test]
    fn render_outputs_chart_blocks() {
        let src = "```chart\n{\"type\":\"bar\",\"labels\":[\"A\"],\"values\":[1]}\n```";
        let res = render(src, None, &[]);
        assert!(res.html.contains("class=\"chart-block\""));
        assert!(res.html.contains("data-chart="));
        assert!(!res.html.contains("data-lang=\"chart\""));
    }

    #[test]
    fn render_outputs_graphviz_blocks() {
        let src = "```dot\ndigraph G { A -> B }\n```";
        let res = render(src, None, &[]);
        assert!(res.html.contains("class=\"graphviz-block\""));
        assert!(res.html.contains("data-graphviz="));
        assert!(!res.html.contains("data-lang=\"dot\""));
    }

    #[test]
    fn render_outputs_plantuml_blocks_with_optional_server() {
        let src =
            "```plantuml server=\"https://example.test/plantuml\"\n@startuml\nA -> B\n@enduml\n```";
        let res = render(src, None, &[]);
        assert!(res.html.contains("class=\"plantuml-block\""));
        assert!(res.html.contains("data-plantuml="));
        assert!(res
            .html
            .contains("data-plantuml-server=\"https://example.test/plantuml\""));
        assert!(!res.html.contains("data-lang=\"plantuml\""));
    }
}
