// 轻量 RSS / Atom 抓取器。
//   * 不开后台调度（前端按 settings.rssFetchInterval 调用即可）
//   * 只取条目元数据 (title / link / pubDate / summary)，不抓正文；正文用浏览器
//     openExternal 跳出去看，避免站点级反爬 / paywall
//   * 限制：单个 feed 最多 50 条，URL 必须 http(s)，body 5 MB 上限

use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_ITEMS: usize = 50;
const REQUEST_TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RssItem {
    pub title: String,
    pub link: String,
    pub pub_date: Option<String>,
    pub summary: Option<String>,
    /// 后端给前端做去重 / 已读 / 未读判断；guid 缺失时退回到 link
    pub guid: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RssFetchResult {
    pub feed_title: Option<String>,
    pub items: Vec<RssItem>,
}

pub async fn fetch(url: &str) -> Result<RssFetchResult, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("URL 无效：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http / https 的 RSS 源".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .user_agent("markio/rss (https://github.com/chenqi92/Markio)")
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;
    let resp = client
        .get(url)
        .header("accept", "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: 服务器拒绝了请求", status.as_u16()));
    }
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!(
            "响应过大：{} 字节，已超过 {} MB 上限",
            bytes.len(),
            MAX_BODY_BYTES / 1024 / 1024
        ));
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    parse(&text)
}

/// 尝试按 RSS 2.0 / Atom 1.0 解析。只看根标签判断哪种。
pub fn parse(xml: &str) -> Result<RssFetchResult, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    // 找到第一个起始元素决定走哪条 parser
    let mut buf = Vec::new();
    let root_tag: Option<String> = loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                break Some(String::from_utf8_lossy(e.name().as_ref()).to_string());
            }
            Ok(Event::Empty(_)) | Ok(Event::Decl(_)) | Ok(Event::Text(_)) => {
                buf.clear();
                continue;
            }
            Ok(Event::Eof) => break None,
            Ok(_) => {
                buf.clear();
                continue;
            }
            Err(e) => return Err(format!("XML 解析失败：{e}")),
        }
    };

    let root = root_tag.ok_or_else(|| "找不到根标签".to_string())?;
    match root.as_str() {
        "rss" => parse_rss(xml),
        "feed" => parse_atom(xml),
        // 有些站点直接以 channel 作根（非标准但常见）
        "channel" => parse_rss(xml),
        other => Err(format!(
            "未识别的根标签 <{}>，仅支持 RSS 2.0 / Atom 1.0",
            other
        )),
    }
}

fn parse_rss(xml: &str) -> Result<RssFetchResult, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut feed_title: Option<String> = None;
    let mut items: Vec<RssItem> = Vec::new();

    // 状态机：当前正在读哪一段
    enum Where {
        Outside,
        Channel,
        ChannelTitle,
        Item,
        ItemTag(&'static str),
    }
    let mut state = Where::Outside;
    let mut cur_title = String::new();
    let mut cur_link = String::new();
    let mut cur_pub = String::new();
    let mut cur_desc = String::new();
    let mut cur_guid = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match (&state, name.as_str()) {
                    (Where::Outside | Where::Channel, "channel") => state = Where::Channel,
                    (Where::Channel, "title") => state = Where::ChannelTitle,
                    (Where::Channel, "item") => {
                        if items.len() >= MAX_ITEMS {
                            break;
                        }
                        cur_title.clear();
                        cur_link.clear();
                        cur_pub.clear();
                        cur_desc.clear();
                        cur_guid.clear();
                        state = Where::Item;
                    }
                    (Where::Item, "title") => state = Where::ItemTag("title"),
                    (Where::Item, "link") => state = Where::ItemTag("link"),
                    (Where::Item, "pubDate") => state = Where::ItemTag("pubDate"),
                    (Where::Item, "description") => state = Where::ItemTag("description"),
                    (Where::Item, "guid") => state = Where::ItemTag("guid"),
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                let text = t
                    .unescape()
                    .map(|s| s.into_owned())
                    .unwrap_or_else(|_| String::from_utf8_lossy(t.as_ref()).into_owned());
                match &state {
                    Where::ChannelTitle => {
                        feed_title.get_or_insert_with(String::new).push_str(&text);
                    }
                    Where::ItemTag("title") => cur_title.push_str(&text),
                    Where::ItemTag("link") => cur_link.push_str(&text),
                    Where::ItemTag("pubDate") => cur_pub.push_str(&text),
                    Where::ItemTag("description") => cur_desc.push_str(&text),
                    Where::ItemTag("guid") => cur_guid.push_str(&text),
                    _ => {}
                }
            }
            Ok(Event::CData(t)) => {
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
                match &state {
                    Where::ChannelTitle => {
                        feed_title.get_or_insert_with(String::new).push_str(&text);
                    }
                    Where::ItemTag("title") => cur_title.push_str(&text),
                    Where::ItemTag("link") => cur_link.push_str(&text),
                    Where::ItemTag("pubDate") => cur_pub.push_str(&text),
                    Where::ItemTag("description") => cur_desc.push_str(&text),
                    Where::ItemTag("guid") => cur_guid.push_str(&text),
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match (&state, name.as_str()) {
                    (Where::ChannelTitle, "title") => state = Where::Channel,
                    (Where::ItemTag(_), _) => state = Where::Item,
                    (Where::Item, "item") => {
                        let link = cur_link.trim().to_string();
                        let title = cur_title.trim().to_string();
                        if !link.is_empty() || !title.is_empty() {
                            let guid = if cur_guid.trim().is_empty() {
                                link.clone()
                            } else {
                                cur_guid.trim().to_string()
                            };
                            items.push(RssItem {
                                title,
                                link,
                                pub_date: option_nonempty(&cur_pub),
                                summary: option_nonempty(&cur_desc).map(|s| strip_html(&s)),
                                guid,
                            });
                        }
                        state = Where::Channel;
                    }
                    (Where::Channel, "channel") => state = Where::Outside,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("RSS 解析失败：{e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(RssFetchResult {
        feed_title: feed_title.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        items,
    })
}

fn parse_atom(xml: &str) -> Result<RssFetchResult, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut feed_title: Option<String> = None;
    let mut items: Vec<RssItem> = Vec::new();

    enum Where {
        Outside,
        Feed,
        FeedTitle,
        Entry,
        EntryTitle,
        EntryUpdated,
        EntrySummary,
        EntryId,
    }
    let mut state = Where::Outside;
    let mut cur_title = String::new();
    let mut cur_link = String::new();
    let mut cur_pub = String::new();
    let mut cur_desc = String::new();
    let mut cur_id = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match (&state, name.as_str()) {
                    (Where::Outside, "feed") => state = Where::Feed,
                    (Where::Feed, "title") => state = Where::FeedTitle,
                    (Where::Feed, "entry") => {
                        if items.len() >= MAX_ITEMS {
                            break;
                        }
                        cur_title.clear();
                        cur_link.clear();
                        cur_pub.clear();
                        cur_desc.clear();
                        cur_id.clear();
                        state = Where::Entry;
                    }
                    (Where::Entry, "title") => state = Where::EntryTitle,
                    (Where::Entry, "updated") => state = Where::EntryUpdated,
                    (Where::Entry, "published") => state = Where::EntryUpdated,
                    (Where::Entry, "summary") | (Where::Entry, "content") => {
                        state = Where::EntrySummary
                    }
                    (Where::Entry, "id") => state = Where::EntryId,
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                // Atom 的 <link href="..." rel="alternate"/> 是空标签
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if matches!(state, Where::Entry) && name == "link" {
                    // 找 href 属性
                    for attr in e.attributes().with_checks(false).flatten() {
                        if attr.key.as_ref() == b"href" {
                            let v = String::from_utf8_lossy(&attr.value).to_string();
                            if cur_link.is_empty() {
                                cur_link = v;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(t)) => {
                let text = t
                    .unescape()
                    .map(|s| s.into_owned())
                    .unwrap_or_else(|_| String::from_utf8_lossy(t.as_ref()).into_owned());
                match &state {
                    Where::FeedTitle => feed_title.get_or_insert_with(String::new).push_str(&text),
                    Where::EntryTitle => cur_title.push_str(&text),
                    Where::EntryUpdated => cur_pub.push_str(&text),
                    Where::EntrySummary => cur_desc.push_str(&text),
                    Where::EntryId => cur_id.push_str(&text),
                    _ => {}
                }
            }
            Ok(Event::CData(t)) => {
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
                match &state {
                    Where::FeedTitle => feed_title.get_or_insert_with(String::new).push_str(&text),
                    Where::EntryTitle => cur_title.push_str(&text),
                    Where::EntryUpdated => cur_pub.push_str(&text),
                    Where::EntrySummary => cur_desc.push_str(&text),
                    Where::EntryId => cur_id.push_str(&text),
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                match (&state, name.as_str()) {
                    (Where::FeedTitle, "title") => state = Where::Feed,
                    (Where::EntryTitle, "title")
                    | (Where::EntryUpdated, "updated")
                    | (Where::EntryUpdated, "published")
                    | (Where::EntrySummary, "summary")
                    | (Where::EntrySummary, "content")
                    | (Where::EntryId, "id") => state = Where::Entry,
                    (Where::Entry, "entry") => {
                        let link = cur_link.trim().to_string();
                        let title = cur_title.trim().to_string();
                        if !link.is_empty() || !title.is_empty() {
                            let guid = if cur_id.trim().is_empty() {
                                link.clone()
                            } else {
                                cur_id.trim().to_string()
                            };
                            items.push(RssItem {
                                title,
                                link,
                                pub_date: option_nonempty(&cur_pub),
                                summary: option_nonempty(&cur_desc).map(|s| strip_html(&s)),
                                guid,
                            });
                        }
                        state = Where::Feed;
                    }
                    (Where::Feed, "feed") => state = Where::Outside,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Atom 解析失败：{e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(RssFetchResult {
        feed_title: feed_title.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        items,
    })
}

fn option_nonempty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// summary / description 里 RSS 站点经常塞 HTML；这里只剥标签，保留文字 + 实体。
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rss20() {
        let xml = r#"<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>Hacker News</title>
<item>
  <title>Post One</title>
  <link>https://news.ycombinator.com/item?id=1</link>
  <pubDate>Mon, 19 May 2026 10:00:00 +0000</pubDate>
  <description><![CDATA[<p>Body here</p>]]></description>
  <guid>https://news.ycombinator.com/item?id=1</guid>
</item>
<item>
  <title>Post Two</title>
  <link>https://news.ycombinator.com/item?id=2</link>
</item>
</channel></rss>"#;
        let r = parse(xml).unwrap();
        assert_eq!(r.feed_title.as_deref(), Some("Hacker News"));
        assert_eq!(r.items.len(), 2);
        assert_eq!(r.items[0].title, "Post One");
        assert_eq!(
            r.items[0].link,
            "https://news.ycombinator.com/item?id=1"
        );
        assert_eq!(r.items[0].summary.as_deref(), Some("Body here"));
    }

    #[test]
    fn parses_atom() {
        let xml = r#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Six Colors</title>
<entry>
  <title>Apple Vision Update</title>
  <link href="https://sixcolors.com/post/x"/>
  <id>tag:sixcolors,2026:post-x</id>
  <updated>2026-05-19T10:00:00Z</updated>
  <summary>Quick take.</summary>
</entry>
</feed>"#;
        let r = parse(xml).unwrap();
        assert_eq!(r.feed_title.as_deref(), Some("Six Colors"));
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].title, "Apple Vision Update");
        assert_eq!(r.items[0].link, "https://sixcolors.com/post/x");
        assert_eq!(r.items[0].guid, "tag:sixcolors,2026:post-x");
        assert_eq!(r.items[0].summary.as_deref(), Some("Quick take."));
    }

    #[test]
    fn falls_back_link_to_guid_when_id_empty() {
        let xml = r#"<rss version="2.0"><channel>
<item><title>X</title><link>https://a/b</link></item>
</channel></rss>"#;
        let r = parse(xml).unwrap();
        assert_eq!(r.items[0].guid, "https://a/b");
    }

    #[test]
    fn strip_html_keeps_text() {
        assert_eq!(strip_html("<p>hi <b>there</b></p>"), "hi there");
        assert_eq!(strip_html("plain"), "plain");
    }

    #[test]
    fn rejects_non_rss_root() {
        let err = parse("<html><body>nope</body></html>").unwrap_err();
        assert!(err.contains("未识别") || err.contains("根标签"));
    }
}
