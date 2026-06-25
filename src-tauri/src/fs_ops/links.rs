//! 重命名 / 移动笔记时，改写其它笔记里指向旧名的 `[[wikilink]]`。
//!
//! See parent module `fs_ops` for orientation.
//!
//! wikilink 解析与前端 `src/lib/wikilinks.ts` 对齐（按文件名 stem 优先，其次
//! 路径尾段匹配），所以改名后这里改写的目标，前端解析器仍能解析到新文件。
//!
//! 只动 `[[...]]`（含嵌入语法 `![[...]]` 的 `[[...]]` 部分）；相对 markdown 链接
//! `[text](path.md)` 的改写留作后续（需逐文件做相对路径运算）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::snapshots::save_snapshot;
use super::walker_io::{atomic_write, ignored_by_rules, is_hidden, is_markdown, MAX_DEPTH};
use crate::ignore::IgnoreRules;

/// wikilink body 的最大字节数。前端正则按 200 **字符** 截断；这里用字节上界放宽，
/// 避免对超长（非链接）方括号串做无谓扫描，同时覆盖 CJK 文件名。
const MAX_WIKI_BODY: usize = 400;

/// 把 wikilink 目标归一化到与前端 `normalizeName` 一致的可比形式：
/// trim → `\`→`/` → 去尾部 `.md` → 去首尾 `/` → 小写。
/// （前端还会 `decodeURIComponent`，这里略过——链接目标极少做百分号编码。）
fn normalize_link_target(s: &str) -> String {
    let mut t = s.trim().replace('\\', "/");
    if t.len() >= 3 && t[t.len() - 3..].eq_ignore_ascii_case(".md") {
        t.truncate(t.len() - 3);
    }
    let t = t.trim_matches('/');
    t.to_lowercase()
}

/// 一次改名涉及的改写计划（旧 stem / 新 stem / 旧绝对路径归一化 / 新仓库相对路径）。
pub(super) struct RenameLinkPlan<'a> {
    /// 旧文件名 stem，小写。
    pub old_stem_lower: &'a str,
    /// 新文件名 stem，原样大小写（写进 `[[...]]`）。
    pub new_stem: &'a str,
    /// 旧文件绝对路径归一化（去 `.md`、小写、`/` 分隔），用于路径尾段匹配。
    pub old_full_noext_lower: &'a str,
    /// 新文件相对仓库根的路径（去 `.md`、`/` 分隔、保留大小写），写进路径式链接。
    pub new_rel_noext: &'a str,
    /// 旧 stem 在仓库里是否唯一（改名后已无其它同 stem 文件）。
    /// 不唯一时不改写裸 stem 链接 `[[Foo]]`，避免误改指向另一个同名笔记的链接。
    pub old_stem_unique: bool,
}

/// 改写单个 wikilink body；命中旧名时返回新 body，否则 None。
/// 保留原 `#heading` 与 `|alias` 部分（逐字），只替换目标段。
fn rewrite_body(body: &str, plan: &RenameLinkPlan) -> Option<String> {
    if body.trim().is_empty() {
        return None;
    }
    // body 顺序：target [# heading] [| alias]——先按首个 `|` 切出 alias，
    // 再把前半按首个 `#` 切出 heading。
    let (target_with_heading, alias) = match body.find('|') {
        Some(k) => (&body[..k], Some(&body[k + 1..])),
        None => (body, None),
    };
    let (target_raw, heading) = match target_with_heading.find('#') {
        Some(k) => (&target_with_heading[..k], Some(&target_with_heading[k + 1..])),
        None => (target_with_heading, None),
    };

    let norm = normalize_link_target(target_raw);
    if norm.is_empty() {
        return None;
    }

    let new_target: String = if norm.contains('/') {
        // 路径式链接：尾段匹配旧绝对路径。
        if plan.old_full_noext_lower == norm
            || plan
                .old_full_noext_lower
                .ends_with(&format!("/{norm}"))
        {
            plan.new_rel_noext.to_string()
        } else {
            return None;
        }
    } else if norm == plan.old_stem_lower && plan.old_stem_unique {
        plan.new_stem.to_string()
    } else {
        return None;
    };

    let mut nb = String::with_capacity(new_target.len() + body.len());
    nb.push_str(&new_target);
    if let Some(h) = heading {
        nb.push('#');
        nb.push_str(h);
    }
    if let Some(a) = alias {
        nb.push('|');
        nb.push_str(a);
    }
    Some(nb)
}

/// 扫描全文里的 `[[...]]`，命中旧名的改写之；有任何改写时返回新文本，否则 None。
/// 手写扫描（不引入 regex 依赖），body 不含 `]` / 换行（与前端正则一致）。
pub(super) fn rewrite_wikilinks(content: &str, plan: &RenameLinkPlan) -> Option<String> {
    let bytes = content.as_bytes();
    let n = bytes.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    let mut changed = false;

    while i < n {
        if bytes[i] == b'[' && i + 1 < n && bytes[i + 1] == b'[' {
            let body_start = i + 2;
            // 找闭合 `]]`：body 不能含 `]` / 换行 / 超长。`]` `\n` `[` 都是 ASCII，
            // UTF-8 续字节恒 ≥0x80，所以逐字节扫不会切断多字节字符。
            let mut j = body_start;
            let mut closed = false;
            while j < n {
                let c = bytes[j];
                if c == b'\n' {
                    break;
                }
                if c == b']' {
                    closed = j + 1 < n && bytes[j + 1] == b']';
                    break;
                }
                if j - body_start >= MAX_WIKI_BODY {
                    break;
                }
                j += 1;
            }
            if closed && j > body_start {
                let body = &content[body_start..j];
                if let Some(new_body) = rewrite_body(body, plan) {
                    out.push_str("[[");
                    out.push_str(&new_body);
                    out.push_str("]]");
                    changed = true;
                    i = j + 2;
                    continue;
                }
            }
        }
        // 原样拷贝当前字符（按 UTF-8 边界推进）。
        let ch = content[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }

    if changed {
        Some(out)
    } else {
        None
    }
}

/// 收集仓库内全部 markdown 文件路径，并按小写 stem 计数（用于判断 stem 唯一性）。
fn collect_md_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    ignore: &IgnoreRules,
    files: &mut Vec<PathBuf>,
    stem_count: &mut HashMap<String, usize>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        if ignored_by_rules(root, &path, ft.is_dir(), ignore) {
            continue;
        }
        if ft.is_dir() {
            collect_md_files(root, &path, depth + 1, ignore, files, stem_count);
        } else if ft.is_file() && is_markdown(&name) {
            if let Some(stem) = path.file_stem() {
                *stem_count
                    .entry(stem.to_string_lossy().to_lowercase())
                    .or_insert(0) += 1;
            }
            files.push(path);
        }
    }
}

/// 把绝对路径归一化成「去 `.md`、`/` 分隔、小写」——与 wikilink 目标归一化同口径，
/// 这样路径式链接的尾段才能与之比对。
fn normalize_abs_noext_lower(path: &str) -> String {
    normalize_link_target(path)
}

/// 计算 new_path 相对 workspace 的路径（去 `.md`、`/` 分隔、保留大小写）。
/// strip_prefix 失败时回退到 new_stem。
fn rel_noext(workspace: &Path, new_path: &Path, new_stem: &str) -> String {
    let rel = new_path
        .strip_prefix(workspace)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let rel = rel.trim_matches('/');
    let rel = rel
        .strip_suffix(".md")
        .or_else(|| rel.strip_suffix(".MD"))
        .unwrap_or(rel);
    if rel.is_empty() {
        new_stem.to_string()
    } else {
        rel.to_string()
    }
}

/// 改名 / 移动后，改写仓库内其它笔记里指向旧名的 `[[wikilink]]`。
/// 每个被改写的文件先存一份历史快照再原子写。返回被改写的文件绝对路径列表。
///
/// 调用方应在真正 rename 之后再调本函数（此时 new_path 已存在、old_path 已不存在），
/// old_path 仅用于推算旧 stem / 旧相对路径，不做文件访问。
pub fn update_wikilinks_on_rename(
    workspace: &str,
    old_path: &str,
    new_path: &str,
) -> Result<Vec<String>, String> {
    let root = Path::new(workspace);
    let old_p = Path::new(old_path);
    let new_p = Path::new(new_path);

    let old_stem_lower = old_p
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let new_stem = new_p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if old_stem_lower.is_empty() || new_stem.is_empty() {
        return Ok(Vec::new());
    }

    let old_full_noext_lower = normalize_abs_noext_lower(old_path);
    let new_rel_noext = rel_noext(root, new_p, &new_stem);

    let ignore = IgnoreRules::load(root);
    let mut files: Vec<PathBuf> = Vec::new();
    let mut stem_count: HashMap<String, usize> = HashMap::new();
    collect_md_files(root, root, 0, &ignore, &mut files, &mut stem_count);

    // 改名后仍存在其它同 stem 文件 ⇒ 裸 `[[Foo]]` 现在合法指向它，不能改写。
    let old_stem_unique = stem_count.get(&old_stem_lower).copied().unwrap_or(0) == 0;

    let plan = RenameLinkPlan {
        old_stem_lower: &old_stem_lower,
        new_stem: &new_stem,
        old_full_noext_lower: &old_full_noext_lower,
        new_rel_noext: &new_rel_noext,
        old_stem_unique,
    };

    let new_canon = fs::canonicalize(new_p).ok();
    let mut changed: Vec<String> = Vec::new();

    for f in files {
        // 跳过被改名的文件自身（不改它内部的自链接）。
        if let Some(nc) = new_canon.as_ref() {
            if fs::canonicalize(&f).ok().as_ref() == Some(nc) {
                continue;
            }
        }
        let Ok(content) = fs::read_to_string(&f) else {
            continue;
        };
        if !content.contains("[[") {
            continue;
        }
        // 廉价预筛：唯一裸 stem 改写要求正文小写含旧 stem；路径式链接才需要全量扫描。
        let lower = content.to_lowercase();
        let path_candidate = old_full_noext_lower.contains('/');
        if !lower.contains(&old_stem_lower) && !path_candidate {
            continue;
        }
        if let Some(next) = rewrite_wikilinks(&content, &plan) {
            let fstr = f.to_string_lossy().to_string();
            // 先快照旧内容（失败不阻断改写）。
            let _ = save_snapshot(workspace, &fstr, &content);
            if atomic_write(&f, &next).is_ok() {
                changed.push(fstr);
            }
        }
    }

    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan<'a>(
        old_stem: &'a str,
        new_stem: &'a str,
        old_full: &'a str,
        new_rel: &'a str,
        unique: bool,
    ) -> RenameLinkPlan<'a> {
        RenameLinkPlan {
            old_stem_lower: old_stem,
            new_stem,
            old_full_noext_lower: old_full,
            new_rel_noext: new_rel,
            old_stem_unique: unique,
        }
    }

    #[test]
    fn rewrites_bare_stem() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        let out = rewrite_wikilinks("see [[Foo]] now", &p).unwrap();
        assert_eq!(out, "see [[Bar]] now");
    }

    #[test]
    fn preserves_heading_and_alias() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        let out = rewrite_wikilinks("[[Foo#Intro|My note]]", &p).unwrap();
        assert_eq!(out, "[[Bar#Intro|My note]]");
    }

    #[test]
    fn heading_only_and_alias_only() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        assert_eq!(
            rewrite_wikilinks("[[Foo#Sec]]", &p).unwrap(),
            "[[Bar#Sec]]"
        );
        assert_eq!(
            rewrite_wikilinks("[[Foo|alias]]", &p).unwrap(),
            "[[Bar|alias]]"
        );
    }

    #[test]
    fn strips_md_extension_in_target() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        let out = rewrite_wikilinks("[[Foo.md]]", &p).unwrap();
        assert_eq!(out, "[[Bar]]");
    }

    #[test]
    fn embed_syntax_rewritten() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        let out = rewrite_wikilinks("![[Foo]]", &p).unwrap();
        assert_eq!(out, "![[Bar]]");
    }

    #[test]
    fn ambiguous_stem_not_rewritten() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", false);
        assert!(rewrite_wikilinks("[[Foo]]", &p).is_none());
    }

    #[test]
    fn path_qualified_link_rewritten() {
        let p = plan("foo", "Bar", "e:/ws/sub/foo", "sub/Bar", true);
        let out = rewrite_wikilinks("[[sub/Foo]]", &p).unwrap();
        assert_eq!(out, "[[sub/Bar]]");
    }

    #[test]
    fn path_qualified_non_match_left_alone() {
        let p = plan("foo", "Bar", "e:/ws/sub/foo", "sub/Bar", true);
        assert!(rewrite_wikilinks("[[other/Foo]]", &p).is_none());
    }

    #[test]
    fn move_only_keeps_bare_stem_when_not_unique() {
        // 纯移动：stem 不变，仓库里仍有该 stem（移动后的文件本身）⇒ 裸链接不动。
        let p = plan("foo", "Foo", "e:/ws/old/foo", "new/Foo", false);
        assert!(rewrite_wikilinks("[[Foo]]", &p).is_none());
        // 但路径式链接要跟着改。
        let out = rewrite_wikilinks("[[old/Foo]]", &p).unwrap();
        assert_eq!(out, "[[new/Foo]]");
    }

    #[test]
    fn non_target_links_untouched() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        assert!(rewrite_wikilinks("[[Other]] and [[Baz#x]]", &p).is_none());
    }

    #[test]
    fn multiple_in_one_doc() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        let out = rewrite_wikilinks("a [[Foo]] b [[Foo|x]] c [[Keep]]", &p).unwrap();
        assert_eq!(out, "a [[Bar]] b [[Bar|x]] c [[Keep]]");
    }

    #[test]
    fn cjk_filename_rewritten() {
        let p = plan("笔记", "新笔记", "e:/ws/笔记", "新笔记", true);
        let out = rewrite_wikilinks("链接 [[笔记]] 到这里", &p).unwrap();
        assert_eq!(out, "链接 [[新笔记]] 到这里");
    }

    #[test]
    fn unclosed_or_newline_body_ignored() {
        let p = plan("foo", "Bar", "e:/ws/foo", "Bar", true);
        // 跨行不是 wikilink。
        assert!(rewrite_wikilinks("[[Foo\nbar]]", &p).is_none());
        // 未闭合不动。
        assert!(rewrite_wikilinks("[[Foo", &p).is_none());
    }

    #[test]
    fn normalize_target_basics() {
        assert_eq!(normalize_link_target("  Foo.md "), "foo");
        assert_eq!(normalize_link_target("Sub\\Foo"), "sub/foo");
        assert_eq!(normalize_link_target("/foo/"), "foo");
    }
}
