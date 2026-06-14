//! Markdown 分块。
//!
//! 策略：
//! 1. 按 ATX 标题切段，标题路径形如 `H1 > H2 > H3`，附加到每个 chunk 的 heading 字段；
//! 2. 标题段内若 > `MAX_CHARS`，按段落（空行）粘合到 `MAX_CHARS` 上限，相邻 chunk 间保留 `OVERLAP_CHARS` 重叠；
//! 3. 代码块作为一个独立 chunk 不拆分；过长的代码块再按行切。
//! 4. token 估算用「中文字 1 token / 英文 4 字符 1 token」混合近似。

pub const MAX_CHARS: usize = 1500;
pub const OVERLAP_CHARS: usize = 180;
pub const MIN_CHARS: usize = 60;

#[derive(Debug, Clone)]
pub struct Chunk {
    pub heading: String,
    pub body: String,
    pub char_start: usize,
    pub char_end: usize,
    pub token_count: usize,
}

#[derive(Debug, Clone)]
struct Section {
    heading: String,
    start: usize,
    end: usize,
}

/// 估算 token 数。CJK 1:1，其他 4:1。
pub fn estimate_tokens(s: &str) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for ch in s.chars() {
        let c = ch as u32;
        if (0x4e00..=0x9fff).contains(&c)
            || (0x3040..=0x30ff).contains(&c)
            || (0xac00..=0xd7af).contains(&c)
        {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + (other / 4).max(other.min(1))
}

/// 把 markdown 切成 chunk。`source` 是完整文档；返回的 `char_start/end` 是 char 索引（按 `chars().count()` 同步）。
pub fn split(source: &str) -> Vec<Chunk> {
    let sections = sections(source);
    let mut out: Vec<Chunk> = Vec::new();
    for sec in sections {
        let body = char_slice(source, sec.start, sec.end);
        if body.trim().is_empty() {
            continue;
        }
        // part 的 start/end 是相对 body 的 char 偏移（指向该 chunk 的新增正文，不含为上下文
        // 而前置的 overlap 尾部），加上 sec.start 即源文绝对偏移，UI 高亮据此可精确定位。
        for part in split_section_body(&body) {
            let token_count = estimate_tokens(&part.text);
            out.push(Chunk {
                heading: sec.heading.clone(),
                body: part.text,
                char_start: sec.start + part.start,
                char_end: sec.start + part.end,
                token_count,
            });
        }
    }
    out
}

/// section 内部聚合出的一块：`text` 含可能前置的 overlap，`start/end` 是相对 body 的 char 偏移，
/// 只覆盖本块新增的段落（不含 overlap），保证相邻块偏移在源文中不重叠、可精确高亮。
struct BodyPart {
    text: String,
    start: usize,
    end: usize,
}

fn char_slice(source: &str, start: usize, end: usize) -> String {
    source
        .chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

/// 把文档切分为 heading 段。无标题文档返回一个空 heading 的整体段。
fn sections(source: &str) -> Vec<Section> {
    let mut out = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut current_start: usize = 0;
    let mut current_heading = String::new();
    let mut char_pos: usize = 0;
    let mut in_fence = false;

    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    for line in lines {
        let trimmed = line.trim_start();
        let line_chars = line.chars().count();
        // 简易代码 fence 检测，标题不能出现在代码块内
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        }
        if !in_fence {
            if let Some((level, title)) = parse_heading(trimmed) {
                // 切出上一个 section
                if char_pos > current_start {
                    out.push(Section {
                        heading: current_heading.clone(),
                        start: current_start,
                        end: char_pos,
                    });
                }
                // 维护 heading 栈：弹出更深/同级 heading
                while let Some(&(lvl, _)) = stack.last() {
                    if lvl >= level {
                        stack.pop();
                    } else {
                        break;
                    }
                }
                stack.push((level, title.clone()));
                current_heading = stack
                    .iter()
                    .map(|(_, t)| t.as_str())
                    .collect::<Vec<_>>()
                    .join(" > ");
                current_start = char_pos + line_chars;
            }
        }
        char_pos += line_chars;
    }
    if char_pos > current_start {
        out.push(Section {
            heading: current_heading,
            start: current_start,
            end: char_pos,
        });
    }
    if out.is_empty() {
        out.push(Section {
            heading: String::new(),
            start: 0,
            end: char_pos,
        });
    }
    out
}

fn parse_heading(s: &str) -> Option<(usize, String)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b'#' {
        i += 1;
    }
    if i == 0 || i > 6 {
        return None;
    }
    // 必须紧跟空白
    if i < bytes.len() && bytes[i] != b' ' && bytes[i] != b'\t' {
        return None;
    }
    let rest = s[i..].trim();
    if rest.is_empty() {
        return None;
    }
    let title = rest.trim_end_matches('#').trim().to_string();
    Some((i, title))
}

/// 按空行切段并保留每段相对 body 的 char 偏移 (start, end)，过滤纯空白段。
/// **代码围栏内的空行不切**，保证 ``` 块作为一个整体 chunk（模块文档承诺）。
fn paragraph_spans(body: &str) -> Vec<(String, usize, usize)> {
    let mut out: Vec<(String, usize, usize)> = Vec::new();
    let mut seg = String::new();
    let mut seg_start = 0usize;
    let mut cur = 0usize; // 当前 char 偏移
    let mut in_fence = false;
    let mut fence_marker: &str = "";

    let flush =
        |out: &mut Vec<(String, usize, usize)>, seg: &mut String, start: usize, end: usize| {
            let trimmed = seg.trim_end_matches('\n');
            if !trimmed.trim().is_empty() {
                out.push((trimmed.to_string(), start, end));
            }
            seg.clear();
        };

    for line in body.split_inclusive('\n') {
        let line_chars = line.chars().count();
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            let marker = if t.starts_with("```") { "```" } else { "~~~" };
            if !in_fence {
                in_fence = true;
                fence_marker = marker;
            } else if t.starts_with(fence_marker) {
                in_fence = false;
            }
        }
        if line.trim().is_empty() && !in_fence {
            flush(&mut out, &mut seg, seg_start, cur);
            cur += line_chars;
            seg_start = cur;
            continue;
        }
        if seg.is_empty() {
            seg_start = cur;
        }
        seg.push_str(line);
        cur += line_chars;
    }
    flush(&mut out, &mut seg, seg_start, cur);
    out
}

/// 在 section 内部按段落聚合到 MAX_CHARS，相邻 chunk overlap OVERLAP_CHARS。
/// 偏移只记录新增段落的覆盖范围，overlap 尾部不计入偏移。
fn split_section_body(body: &str) -> Vec<BodyPart> {
    let total = body.chars().count();
    if total <= MAX_CHARS {
        return vec![BodyPart {
            text: body.to_string(),
            start: 0,
            end: total,
        }];
    }
    let mut chunks: Vec<BodyPart> = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;
    let mut cur_start: Option<usize> = None;
    let mut cur_end = 0usize;
    for (p, p_start, p_end) in paragraph_spans(body) {
        let p_len = p.chars().count();
        if current_chars + p_len + 2 > MAX_CHARS && !current.is_empty() {
            // flush；overlap 尾部前置到下一块，但不计入偏移
            let tail: String = current
                .chars()
                .rev()
                .take(OVERLAP_CHARS)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            chunks.push(BodyPart {
                text: std::mem::take(&mut current),
                start: cur_start.take().unwrap_or(0),
                end: cur_end,
            });
            current.push_str(&tail);
            current_chars = tail.chars().count();
        }
        if cur_start.is_none() {
            cur_start = Some(p_start);
        }
        if !current.is_empty() {
            current.push_str("\n\n");
            current_chars += 2;
        }
        current.push_str(&p);
        current_chars += p_len;
        cur_end = p_end;
        if current_chars > MAX_CHARS * 2 {
            // 单个段落本身就过大，硬切
            chunks.push(BodyPart {
                text: std::mem::take(&mut current),
                start: cur_start.take().unwrap_or(0),
                end: cur_end,
            });
            current_chars = 0;
        }
    }
    if !current.trim().is_empty() {
        chunks.push(BodyPart {
            text: current,
            start: cur_start.unwrap_or(0),
            end: cur_end,
        });
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_is_rough_quarter_of_chars() {
        let s = "the quick brown fox jumps";
        let t = estimate_tokens(s);
        assert!(t > 0);
        assert!(t <= s.len());
    }

    #[test]
    fn split_returns_at_least_one_chunk_on_nonempty_input() {
        let chunks = split("# Title\n\nSome content here.\n");
        assert!(!chunks.is_empty());
    }

    #[test]
    fn split_keeps_heading_with_body() {
        let chunks = split("# Header\n\nBody text.\n");
        assert!(chunks[0].body.contains("Header") || chunks[0].heading.contains("Header"));
    }

    #[test]
    fn parse_heading_extracts_level_and_text() {
        let (level, text) = parse_heading("## Hello").expect("expected heading");
        assert_eq!(level, 2);
        assert_eq!(text, "Hello");
        assert!(parse_heading("not a heading").is_none());
    }

    #[test]
    fn paragraph_spans_keeps_fenced_block_with_blank_lines() {
        // 围栏内含空行不应被切成多段
        let body = "intro\n\n```py\na = 1\n\nb = 2\n```\n\nouter";
        let spans = paragraph_spans(body);
        let texts: Vec<&str> = spans.iter().map(|(t, _, _)| t.as_str()).collect();
        assert!(texts
            .iter()
            .any(|t| t.contains("a = 1") && t.contains("b = 2")));
        // intro / 代码块 / outer 三段，而不是把代码块拆开
        assert_eq!(spans.len(), 3);
    }
}
