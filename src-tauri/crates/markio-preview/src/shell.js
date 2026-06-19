// 与 Rust 的双向通道：JS → Rust 用 wry 的 window.ipc.postMessage；
// Rust → JS 用 evaluate_script 调 window.__setDoc(...)。
(function () {
  function send(msg) {
    if (window.ipc && window.ipc.postMessage) {
      window.ipc.postMessage(JSON.stringify(msg));
    }
  }

  // 键盘：←/k/PageUp 上一篇，→/j/PageDown 下一篇
  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "j":
      case "PageDown":
      case " ":
        send({ action: "next" });
        e.preventDefault();
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "k":
      case "PageUp":
        send({ action: "prev" });
        e.preventDefault();
        break;
      case "Escape":
        send({ action: "close" });
        break;
    }
  });

  // 点击顶部文件条切换
  document.addEventListener("click", function (e) {
    var tab = e.target.closest("[data-idx]");
    if (tab) send({ action: "open", idx: parseInt(tab.dataset.idx, 10) });
  });

  // Rust 渲染好新文档后回调：替换文件条 + 正文 + 标题，并滚回顶部
  window.__setDoc = function (payload) {
    var bar = document.getElementById("bar");
    var content = document.getElementById("content");
    if (bar) bar.innerHTML = payload.bar;
    if (content) {
      content.innerHTML = payload.body;
      content.scrollTop = 0;
    }
    document.title = payload.title;
    window.scrollTo(0, 0);
    var active = document.querySelector("#bar .tab.active");
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "nearest", inline: "center" });
    }
  };
})();
