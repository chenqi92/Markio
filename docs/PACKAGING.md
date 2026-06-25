# 打包 & 上架

## 一句话概览

- **直发渠道**：Developer ID Application 证书 → `scripts/notarize.sh` → `.dmg`
- **Mac App Store**：Mac App Distribution + Mac Installer Distribution 证书 → `scripts/build-mas.sh` → `.pkg` → Transporter 上传
- **Windows**：`pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi` 在 Windows 机器上跑

## 一、准备工作

1. 加入 Apple Developer Program（个人 $99/年）
2. 在 https://developer.apple.com/account 创建 App ID：
   - Bundle ID：`com.welape.mdview`（与 `tauri.conf.json` 里的 identifier 一致）
   - 勾上 Capabilities → **App Sandbox**
3. 创建三张证书并下到本机钥匙串：
   - `Mac App Distribution`（用来给上架包里的 `.app` 签名）
   - `Mac Installer Distribution`（用来给 `.pkg` 签名）
   - `Developer ID Application`（直发渠道用）
4. 在 App Store Connect 建好应用，拿到 SKU / 中文截图 / 隐私清单
5. macOS 沙盒权限已经在 `src-tauri/entitlements/macos.entitlements` 中声明：
   - `app-sandbox` + `files.user-selected.read-write` + `files.bookmarks.app-scope` + `network.client`

## 二、发布前检查

每次发版前先从干净的 `main` 分支执行：

```bash
pnpm release:preflight
```

它会依次跑：

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm e2e`
- `pnpm release:check`

`release:check` 是静态发布配置检查，覆盖：

- `package.json`、`src-tauri/tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 版本一致。
- Tauri updater 已启用，`createUpdaterArtifacts`、公钥和 `latest.json` endpoint 已配置。
- GitHub release workflow 使用 `tauri-apps/tauri-action`，并读取 `TAURI_SIGNING_PRIVATE_KEY`。
- CI 已执行前端 lint / build / Vitest / Playwright，以及 Rust fmt / test / clippy。
- macOS entitlements、隐私清单、MAS 打包脚本、公证脚本都存在。

人工确认项：

- GitHub Actions secrets 中存在 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- macOS 直发包完成 `notarytool` 公证和 `stapler` 打钉验证。
- GitHub Release 附带安装包和 updater `latest.json`。
- 保留上一版 release asset，不删除上一版 tag；回滚时把用户引导回上一版安装包，必要时把 updater endpoint 指向上一版 `latest.json`。

## 三、Mac App Store 打包

```bash
APPLE_SIGNING_IDENTITY="3rd Party Mac Developer Application: 韩 ABCDE12345" \
APPLE_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: 韩 ABCDE12345" \
APPLE_TEAM_ID="ABCDE12345" \
PROVISIONING_PROFILE="$HOME/Downloads/markio_mas.provisionprofile" \
./scripts/build-mas.sh
```

产物：`dist-mas/markio.pkg`

上传：
- 打开 Xcode → Window → Organizer → Mac Apps，把 `.pkg` 拖进来 → Distribute App
- 或者直接打开 **Transporter.app**（Mac App Store 上免费下载），把 `.pkg` 拖进去
- 或者配置 App Store Connect API Key 后执行：

```bash
APP_STORE_CONNECT_API_KEY="ABC123DEFG" \
APP_STORE_CONNECT_API_ISSUER="00000000-0000-0000-0000-000000000000" \
APP_STORE_CONNECT_API_KEY_PATH="$HOME/.private_keys/AuthKey_ABC123DEFG.p8" \
./scripts/upload-mas.sh
```

## 四、直发渠道（DMG + 公证）

```bash
# 第一次配置公证凭据
xcrun notarytool store-credentials "markio-notary" \
  --apple-id "you@example.com" \
  --team-id "ABCDE12345" \
  --password "abcd-efgh-ijkl-mnop"  # app-specific password

APPLE_SIGNING_IDENTITY="Developer ID Application: 韩 ABCDE12345" \
./scripts/notarize.sh
```

产物：`src-tauri/target/universal-apple-darwin/release/bundle/dmg/markio_*.dmg`

## 五、Windows / Linux

```bash
# Windows 上跑（先安装 Rust toolchain + WebView2）
pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi,nsis

# Linux
pnpm tauri build --bundles appimage,deb
```

Windows Store（MSIX）：

> 已确认（tauri-cli 2.11.1）：`tauri build -b` 的 `[possible values]` 只有 `msi, nsis`，
> 没有 `msix`。下面流程是「先出 MSI → 转 MSIX」的官方推荐路径，不依赖 CLI 原生支持。

Tauri 2.x bundler 目前仍主推 MSI/NSIS；MSIX 需要在 MSI 基础上再用官方工具
`MSIX Packaging Tool`（Windows 10+ 自带）或 `msi-to-msix` 转换。流程：

```powershell
# 1) 先出 MSI
pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi

# 2) 用 MSIX Packaging Tool（图形化）或 MakeAppx.exe 转 MSIX
makeappx pack /d <unpacked_dir> /p markio.msix

# 3) signtool 签名（需 Azure Code Signing 或 EV 证书）
signtool sign /fd SHA256 /a /n "<Publisher CN>" markio.msix

# 4) 上传到 Partner Center → Microsoft Store
```

CI 自动化建议放到独立 workflow（与 `release.yml` 解耦），因为 Partner Center
凭据轮换较频繁；样例参考：`.github/workflows/release.yml` 的 windows-x64 job
继续补 `--bundles msix` 步骤（待官方 bundler 提供原生支持后切换）。

## 六、常见问题

| 现象 | 处理 |
| --- | --- |
| `codesign: errSecInternalComponent` | 钥匙串解锁：`security unlock-keychain login.keychain` |
| `notarytool` 卡在 In Progress | 苹果队列正常会 1-10 分钟，超过 30 分钟用 `xcrun notarytool log <id>` 查日志 |
| 上传后 App Store Connect 显示 ITMS-90238 | entitlements 里有禁用项目；用 `codesign -d --entitlements - <app>` 校对一遍 |
| 沙盒里读不到文件 | 走系统 Open Panel（`pickDirectory` / `pickFile`），不要硬编码路径 |
| Hardened runtime 报 EXC_BAD_INSTRUCTION | 升级 Rust + 重跑，必要时加 `-allow-jit` 等 entitlement |

## 七、自动化（GitHub Actions 草稿）

参考 `.github/workflows/release.yml`（可后续补）：使用 `tauri-apps/tauri-action` 的官方 Action 绑定证书与公证凭据。

## 八、本地调试三种 AI 视图（AI region / MAS 裁剪）

AI 功能可见性由两个**编译期** flag 决定，分别映射到前端常量：

| 环境变量 | 前端常量 | 作用 |
| --- | --- | --- |
| `VITE_MARKIO_AI_REGION` | `__MARKIO_AI_REGION__` | `cn` / `global` / 不设（auto）。控制 HTTP provider 列表与外部 Agent 是否暴露。 |
| `VITE_MARKIO_MAS` | `__MARKIO_MAS__` | 置 `1` 表示 Mac App Store 沙盒包，裁掉无法过审的能力。 |

区域解析顺序：`VITE_MARKIO_AI_REGION` 显式指定 > storefront/runtime 覆盖 > **`vite dev` 默认 global** > 运行时按时区 / 语言自动判定。
因此**本地 `pnpm tauri:dev` 默认就能看到全部 AI 功能**，不会因为开发机在国内被收敛成国区视图（生产构建 `import.meta.env.DEV=false`，不受影响）。

三种调试视图：

```powershell
# 1) 全部 AI 功能（默认）：9 家本地 Agent + 全部 HTTP provider（含 Anthropic / OpenAI / Google …）
pnpm tauri:dev

# 2) 国区受限视图：无外部 Agent，HTTP 只剩 DeepSeek / 硅基 / 智谱 / 通义 / Kimi / 小米 / Ollama
$env:VITE_MARKIO_AI_REGION='cn'; pnpm tauri:dev

# 3) Mac App Store 裁剪版预览：本地 Agent 整功能消失（验证苹果审核版的样子）
$env:VITE_MARKIO_MAS='1'; pnpm tauri:dev
```

> bash / zsh 下对应写法是 `VITE_MARKIO_AI_REGION=cn pnpm tauri:dev`；改 flag 后需**重启 dev server** 生效。
> `$env:` 设过的变量会留在当前 PowerShell 会话，测完用 `Remove-Item Env:VITE_MARKIO_AI_REGION` 清掉，或新开一个终端。

### 为什么本地 CLI Agent 必须随 MAS 裁掉

「本地 Agent」面板会 spawn 用户 PATH 里的外部可执行文件（`claude` / `codex` / `agy` / `cursor-agent` / `opencode` / `qwen` / `copilot` / `aider` / `goose`）。
macOS App Sandbox 禁止沙盒进程拉起包外、未签 `inherit` entitlement 的二进制——子进程会被直接 kill，带此能力提交还有被审核拒绝的风险。
所以前端用 `isLocalAgentEnabled()`（`src/lib/ai-region-policy.ts`）在 `__MARKIO_MAS__` 为真时整功能隐藏；`scripts/build-mas.sh` 已置 `VITE_MARKIO_MAS=1`，上架链路自动生效。
直发渠道（DMG / Windows / Linux）不沙盒，功能照常。同理 `markio-preview` 外部二进制、Apple Notes 导入也都是 MAS 版裁掉的。
