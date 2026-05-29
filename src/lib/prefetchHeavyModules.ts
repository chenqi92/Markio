/**
 * 应用启动后趁主线程空闲，预先 import 几个用户大概率会用到的重型 module，
 * 避免：
 *
 *   - 滚动到第一个 mermaid 图时编辑器卡 200~500ms（mermaid.core ~580KB）
 *   - 第一个 Graphviz 图时 WASM 实例化卡 1s+（viz.js ~1.3MB）
 *   - 第一个 `$$...$$` 公式时 KaTeX 现拉（~256KB）
 *
 * 这些 module 都用 `import()` 动态加载，浏览器 / Vite 会自动复用首次解析的
 * 结果；这里只是把"首次解析"挪到 idle 阶段。
 *
 * 用 requestIdleCallback，没有就退化成 setTimeout(0)；避免和首屏渲染抢线程。
 */

const PREFETCH_DELAY_MS = 1500;

let started = false;

export function prefetchHeavyModulesOnce(): void {
  if (started) return;
  started = true;
  // 先等一段，让首屏 paint / hydrate / session restore 跑完；再排到 idle
  setTimeout(() => {
    schedule(() => {
      // 失败也无所谓：用户用到时还会再触发动态 import
      void import("katex").catch(() => undefined);
    });
    schedule(() => {
      void import("mermaid").catch(() => undefined);
    });
    schedule(() => {
      void import("@viz-js/viz").catch(() => undefined);
    });
  }, PREFETCH_DELAY_MS);
}

function schedule(fn: () => void) {
  if (
    typeof window !== "undefined" &&
    typeof window.requestIdleCallback === "function"
  ) {
    window.requestIdleCallback(() => fn(), { timeout: 4000 });
  } else {
    setTimeout(fn, 0);
  }
}
