# Markio Web Clipper

一个 Manifest V3 浏览器扩展，把当前网页或选中内容「剪藏」发送到本机运行的 Markio WebClipper 接收端。

纯 vanilla JS，无需构建、无 npm 依赖。

## 工作原理

- 扩展从右键菜单或弹窗触发后，向当前页面注入一个抓取脚本：
  - 若有选区，取选区的 HTML（`Range.cloneContents()` + 容器 `innerHTML`）；
  - 选区为空时退回整页 `document.documentElement.outerHTML`。
- 连同 `title`、`url`、`selection` 标志，`POST` 到 `${endpoint}/clip`。
- 反馈通过扩展图标上的角标（✓ / ✗）显示，几秒后自动清除。

请求体 JSON：

```json
{
  "url": "https://example.com/article",
  "title": "文章标题",
  "html": "<article>...选中或整页的 HTML...</article>",
  "selection": true
}
```

请求头：`Authorization: Bearer <token>`

预期响应：`{ "ok": true, "path": "<写入的 md 路径>" }`，或非 2xx + 文本错误。

## 安装（开发者模式 / 加载已解压扩展）

### Chrome

1. 打开 `chrome://extensions`。
2. 右上角打开「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录 `clipper-extension/`。

### Edge

1. 打开 `edge://extensions`。
2. 左下角打开「开发人员模式」。
3. 点击「加载解压缩的扩展」。
4. 选择本目录 `clipper-extension/`。

## 配置

1. 在 Markio 中打开「设置 → 网页收藏」，复制接收端地址（如 `http://127.0.0.1:8787`）和 token。
2. 点击浏览器工具栏上的扩展图标打开弹窗。
3. 把地址和 token 填入对应输入框，点击「保存」（保存在 `chrome.storage.local`）。
4. 点击「测试连接」确认能连上接收端。

## 使用

- **整页剪藏**：在页面任意处右键 →「剪藏到 Markio」，或在弹窗点「剪藏当前页」。
- **选区剪藏**：先选中一段内容，右键 →「剪藏到 Markio」。

成功时扩展图标显示 ✓，失败显示 ✗（鼠标悬停图标可看简短原因），弹窗内也会显示更详细的信息（含返回的 md 路径或错误文本）。

## 安全说明

- 扩展只通过 `host_permissions: http://127.0.0.1/*` 访问本机回环地址，不会把内容发送到任何外部服务器。
- token 仅保存在本地浏览器 `chrome.storage.local`，仅用于向本机 Markio 鉴权。
- 请勿把接收端地址改成非 `127.0.0.1` 的地址；该扩展的网络权限也仅限本机回环。

## 故障排查

- **测试连接 / 剪藏失败，提示无法连接**：确认 Markio 正在运行，且设置中的端口与扩展里填写的一致。
- **提示尚未配置**：在弹窗中填写并「保存」地址和 token。
- **某些页面无法剪藏**：浏览器内置页面（如 `chrome://`、扩展商店页）不允许脚本注入，属预期限制。
- **CORS**：service worker 携带 `host_permissions` 向 `127.0.0.1` 发请求一般不受页面 CORS 限制；若仍失败，优先检查 Markio 接收端是否在运行、端口/ token 是否正确。
