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
        let mut parts = split_section_body(&body);
        // 给每个 part 补上 heading + 计算偏移
        let mut cursor = sec.start;
        for p in parts.drain(..) {
            let part_len = p.chars().count();
            let start = cursor;
            let end = cursor + part_len;
            cursor = end.saturating_sub(part_len.min(OVERLAP_CHARS));
            if p.trim().chars().count() < MIN_CHARS && !sec.heading.is_empty() {
                // 太短的内容并入 heading 即可
            }
            let token_count = estimate_tokens(&p);
            out.push(Chunk {
                heading: sec.heading.clone(),
                body: p,
                char_start: start.min(end),
                char_end: end,
                token_count,
            });
        }
    }
    out
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

/// 在 section 内部按段落聚合到 MAX_CHARS，相邻 chunk overlap OVERLAP_CHARS。
fn split_section_body(body: &str) -> Vec<String> {
    if body.chars().count() <= MAX_CHARS {
        return vec![body.to_string()];
    }
    let paragraphs: Vec<&str> = body
        .split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;
    for p in paragraphs {
        let p_len = p.chars().count();
        if current_chars + p_len + 2 > MAX_CHARS && !current.is_empty() {
            // flush
            let tail: String = current
                .chars()
                .rev()
                .take(OVERLAP_CHARS)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            chunks.push(std::mem::take(&mut current));
            current.push_str(&tail);
            current_chars = tail.chars().count();
        }
        if !current.is_empty() {
            current.push_str("\n\n");
            current_chars += 2;
        }
        current.push_str(p);
        current_chars += p_len;
        if current_chars > MAX_CHARS * 2 {
            // 单个段落本身就过大，硬切
            chunks.push(std::mem::take(&mut current));
            current_chars = 0;
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}
