//! markdown 渲染核心已抽到独立 crate `markio-render`，供主 app 与轻量预览器复用。
//! 这里仅做 re-export，保持 `markdown::render` / `markdown::OutlineItem` 等历史调用点不变。
pub use markio_render::*;
