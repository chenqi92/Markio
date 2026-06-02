// Markio Web Clipper - background service worker (MV3)
//
// Responsibilities:
//  - Register a context menu ("Clip to Markio") for page + selection.
//  - On menu click or popup message, inject a grabber into the active tab to
//    collect { html, title, url, selection }.
//  - Read endpoint + token from chrome.storage.local and POST to `${endpoint}/clip`.
//  - Give feedback via the action badge (no extra permissions needed).

const MENU_ID = "markio-clip";

// ---------------------------------------------------------------------------
// Context menu setup
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "剪藏到 Markio",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab || tab.id == null) {
    flashBadge(false, "no tab");
    return;
  }
  clipTab(tab.id).catch((err) => {
    console.error("[Markio] clip failed:", err);
  });
});

// ---------------------------------------------------------------------------
// Messages from popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "markio-clip-current") return false;
  (async () => {
    try {
      const tab = await getActiveTab();
      if (!tab || tab.id == null) throw new Error("找不到当前标签页");
      const result = await clipTab(tab.id);
      sendResponse({ ok: true, path: result.path });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  // Return true to keep the message channel open for the async response.
  return true;
});

// ---------------------------------------------------------------------------
// Core clip flow
// ---------------------------------------------------------------------------
async function clipTab(tabId) {
  const { endpoint, token } = await getConfig();
  if (!endpoint || !token) {
    flashBadge(false, "config");
    throw new Error("尚未配置接收端地址或 token，请在扩展弹窗中填写并保存");
  }

  const payload = await grabFromTab(tabId);

  const url = joinUrl(endpoint, "/clip");
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (netErr) {
    flashBadge(false, "net");
    throw new Error(`无法连接到接收端 ${url}，请确认 Markio 正在运行：${netErr}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    flashBadge(false, String(res.status));
    throw new Error(`接收端返回 ${res.status}：${text || "(无内容)"}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (_e) {
    data = {};
  }

  if (data && data.ok === false) {
    flashBadge(false, "err");
    throw new Error(`接收端拒绝：${data.error || "未知错误"}`);
  }

  flashBadge(true);
  return { path: (data && data.path) || "" };
}

// Inject the grabber and return its payload. Falls back to whole page when the
// selection is empty.
async function grabFromTab(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: grabPageOrSelection,
  });
  if (!injection || !injection.result) {
    throw new Error("无法读取页面内容（页面可能不允许脚本注入，如 chrome:// 页面）");
  }
  return injection.result;
}

// This function is serialized and runs in the page context. Keep it self-contained.
function grabPageOrSelection() {
  const title = document.title || "";
  const url = location.href;

  const sel = window.getSelection ? window.getSelection() : null;
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const container = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    const html = container.innerHTML.trim();
    if (html) {
      return { url, title, html, selection: true };
    }
  }

  // No usable selection -> fall back to the whole document.
  return {
    url,
    title,
    html: document.documentElement.outerHTML,
    selection: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function getConfig() {
  const { endpoint, token } = await chrome.storage.local.get(["endpoint", "token"]);
  return {
    endpoint: (endpoint || "").trim().replace(/\/+$/, ""),
    token: (token || "").trim(),
  };
}

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

let badgeTimer = null;
function flashBadge(ok, hint) {
  const text = ok ? "✓" : "✗";
  const color = ok ? "#2e7d32" : "#c62828";
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    if (hint) chrome.action.setTitle({ title: `Markio Web Clipper - ${hint}` });
  } catch (_e) {
    /* action API may be unavailable in rare cases */
  }
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    try {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Markio Web Clipper" });
    } catch (_e) {
      /* ignore */
    }
  }, 4000);
}
