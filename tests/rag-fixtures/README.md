# RAG 评估 fixtures

每个 `*.json` 都是一组「问题 → 期望命中文档」的样例，给 `rag_eval` 当 ground truth。

```
{
  "fixtures": [
    {
      "query": "如何配置 PicGo？",
      "expected": ["docs/picgo.md", "notes/setup.md"]
    }
  ]
}
```

跑：

```
cd src-tauri
cargo run --bin rag_eval -- \
    --workspace /path/to/already/indexed/workspace \
    --fixture ../tests/rag-fixtures/sample.json \
    --k 10 \
    --provider ollama --model nomic-embed-text --dim 768
```

输出 recall@K + MRR + 每条命中明细。

注意：workspace 必须**已经索引过**；CLI 不会主动重建索引（避免误删生产数据）。
