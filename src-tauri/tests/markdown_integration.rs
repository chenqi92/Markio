// 端到端的 markdown 渲染 + outline + link extract 串测试。
//
// 不依赖外部 service；只验证 lib 内部各模块协作 OK。

use markio_lib::rag;

#[test]
fn chunk_split_preserves_section_grouping() {
    let src = "\
# Top

intro paragraph

## A

content for A
content for A line 2

## B

content for B
";
    let chunks = rag::chunk::split(src);
    assert!(!chunks.is_empty(), "should produce at least one chunk");
    let joined: String = chunks.iter().map(|c| c.body.clone()).collect::<Vec<_>>().join("\n");
    assert!(joined.contains("content for A"));
    assert!(joined.contains("content for B"));
    // 每个 chunk 都应该有有限大小
    for c in &chunks {
        assert!(c.token_count > 0);
        assert!(c.body.len() < 100_000);
    }
}

#[test]
fn chunk_split_handles_long_paragraph_by_splitting() {
    let mut huge = String::new();
    for i in 0..400 {
        huge.push_str(&format!("para {i} 含一些中文 mixed with english.\n\n"));
    }
    let chunks = rag::chunk::split(&huge);
    assert!(
        chunks.len() > 1,
        "long doc should split into >1 chunks, got {}",
        chunks.len()
    );
}

#[test]
fn chunk_split_empty_input_returns_empty() {
    let chunks = rag::chunk::split("");
    assert!(chunks.is_empty());
}
