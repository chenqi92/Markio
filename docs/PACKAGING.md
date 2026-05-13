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

## 二、Mac App Store 打包

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

## 三、直发渠道（DMG + 公证）

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

## 四、Windows / Linux

```bash
# Windows 上跑（先安装 Rust toolchain + WebView2）
pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi,nsis

# Linux
pnpm tauri build --bundles appimage,deb
```

Windows Store（MSIX）：

```bash
pnpm tauri build --target x86_64-pc-windows-msvc --bundles msi
# 上传到 Partner Center 走 MSI/MSIX 渠道
```

## 五、常见问题

| 现象 | 处理 |
| --- | --- |
| `codesign: errSecInternalComponent` | 钥匙串解锁：`security unlock-keychain login.keychain` |
| `notarytool` 卡在 In Progress | 苹果队列正常会 1-10 分钟，超过 30 分钟用 `xcrun notarytool log <id>` 查日志 |
| 上传后 App Store Connect 显示 ITMS-90238 | entitlements 里有禁用项目；用 `codesign -d --entitlements - <app>` 校对一遍 |
| 沙盒里读不到文件 | 走系统 Open Panel（`pickDirectory` / `pickFile`），不要硬编码路径 |
| Hardened runtime 报 EXC_BAD_INSTRUCTION | 升级 Rust + 重跑，必要时加 `-allow-jit` 等 entitlement |

## 六、自动化（GitHub Actions 草稿）

参考 `.github/workflows/release.yml`（可后续补）：使用 `tauri-apps/tauri-action` 的官方 Action 绑定证书与公证凭据。
