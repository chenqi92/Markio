// Markio Web Clipper - popup logic

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";

const $endpoint = document.getElementById("endpoint");
const $token = document.getElementById("token");
const $save = document.getElementById("save");
const $test = document.getElementById("test");
const $clip = document.getElementById("clip");
const $status = document.getElementById("status");

function setStatus(text, kind) {
  $status.textContent = text || "";
  $status.className = kind || "";
}

function normEndpoint(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function joinUrl(base, path) {
  const b = normEndpoint(base);
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

// Load saved config on open.
chrome.storage.local.get(["endpoint", "token"]).then(({ endpoint, token }) => {
  $endpoint.value = endpoint || DEFAULT_ENDPOINT;
  $token.value = token || "";
});

$save.addEventListener("click", async () => {
  const endpoint = normEndpoint($endpoint.value) || DEFAULT_ENDPOINT;
  const token = ($token.value || "").trim();
  await chrome.storage.local.set({ endpoint, token });
  $endpoint.value = endpoint;
  setStatus("已保存。", "ok");
});

$test.addEventListener("click", async () => {
  const endpoint = normEndpoint($endpoint.value);
  const token = ($token.value || "").trim();
  if (!endpoint) {
    setStatus("请先填写接收端地址。", "err");
    return;
  }
  setStatus("测试中…");
  const url = joinUrl(endpoint, "/clip/health");
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      setStatus(`连接正常 (HTTP ${res.status})。`, "ok");
    } else {
      const body = await res.text().catch(() => "");
      setStatus(`接收端返回 HTTP ${res.status}。${body ? "\n" + body : ""}`, "err");
    }
  } catch (err) {
    setStatus(
      `无法连接 ${url}\n请确认 Markio 正在运行，且地址与端口正确。\n${err}`,
      "err"
    );
  }
});

$clip.addEventListener("click", async () => {
  const endpoint = normEndpoint($endpoint.value);
  const token = ($token.value || "").trim();
  if (!endpoint || !token) {
    setStatus("请先填写并保存接收端地址和 token。", "err");
    return;
  }
  setStatus("剪藏中…");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "markio-clip-current" });
    if (resp && resp.ok) {
      setStatus(`已剪藏。${resp.path ? "\n" + resp.path : ""}`, "ok");
    } else {
      setStatus(`剪藏失败：${(resp && resp.error) || "未知错误"}`, "err");
    }
  } catch (err) {
    setStatus(`剪藏失败：${err}`, "err");
  }
});
