# markio-preview

Markio 的超轻量 markdown 预览器。独立进程、复用 `markio-render` 渲染核心，
shell 启动、当前目录自动发现 + 前后切换。release 二进制约 3MB。

## 能力

- 渲染：标题/列表/表格/引用/链接、syntect 语法高亮（亮+暗随系统）、本地图片内联 data URI。
- 目录发现：自动列出同目录全部 `.md/.markdown/.mdown/.mkd`，顶部文件条点击切换。
- 键盘：`←/→`、`j/k`、空格/PageUp·Down 切换，`Esc` 关闭。
- 单实例：已有窗口时把新文件转发给它并切换（不另起进程）。
- mermaid/chart/graphviz/数学公式：v1 以源码兜底块展示（后续可懒加载 mermaid/katex）。

## 构建 / 调试

```bash
cargo build --release -p markio-preview          # 产物 target/release/markio-preview
./target/release/markio-preview path/to/file.md  # 直接看窗口
./target/release/markio-preview --dump file.md   # 仅输出整页 HTML（无窗口，便于测试）
```

排障：在临时目录建 `markio-preview.debug` 标记文件，事件会写入 `markio-preview.log`
（对 `open -a` 这类拿不到 stdout 的启动路径很有用）。

## macOS 集成（已在本机验证）

文件经 `application:openURLs:` 抵达，tao 暴露为 `Event::Opened`，**无需 objc 代码**。

```bash
crates/markio-preview/macos/bundle.sh [输出目录] [--sign "Developer ID Application: ..."]
crates/markio-preview/macos/install-quickaction.sh            # 安装右键快捷操作
crates/markio-preview/macos/install-quickaction.sh --uninstall
```

- `bundle.sh` 把二进制组装成 `Markio Preview.app`（`Info.plist` 声明 .md 的 Viewer 角色
  → 右键"打开方式"出现；双击/打开方式经 `Event::Opened` 渲染；同一 .app 再开别的文件由
  macOS 复用实例 + `Event::Opened` 切换——已验证）。
- 快捷操作 `Markio 预览`（右键 → 快捷操作）走 `open -a "Markio Preview"`，全部路径统一经 .app。

## Windows 集成（待在 Windows 上验证）

右键菜单"用 Markio 预览"经 NSIS 安装钩子写注册表：

- `windows/installer-hooks.nsh`：在 `tauri.conf.json` 里
  `bundle.windows.nsis.installerHooks` 指向它，安装时给 .md 家族注册右键 verb，
  指向 `$INSTDIR\markio-preview.exe`。
- `windows/markio-preview.reg.template`：手动/便携版导入用。

预览器二进制需随主包安装到 `$INSTDIR\markio-preview.exe`（用 `bundle.resources`
或 `externalBin` 把 `markio-preview.exe` 带进安装目录）。

## 待接入主仓（需改 release 配置，建议确认后再动）

1. 让 release 同时构建 `markio-preview`（Cargo workspace 已就位）。
2. macOS：在打包/签名脚本里调用 `bundle.sh`，把 `Markio Preview.app` 放进 DMG，
   首次运行时装快捷操作。
3. Windows：`tauri.conf.json` 加 `installerHooks` + 把 `markio-preview.exe` 纳入安装目录。

## 签名 / 上架注意

- **直发包（GitHub Releases）**：macOS 用 Developer ID 签名 + 公证；Windows 用 OV/EV
  证书签名。预览器是独立无沙盒 app，本地文件随便读（所以同目录图片能内联——这点优于
  Quick Look 沙盒扩展）。
- **Mac App Store**：MAS 要求 bundle 内所有可执行文件都沙盒化。若要把预览器塞进 MAS 包，
  它也得沙盒 + 单独描述文件，且会重新撞上"读不到同级文件"等沙盒限制。**建议预览器只随
  直发包分发**，MAS 包维持现状，避免污染既有上架链路。
- **Microsoft Store**：非打包 EXE/MSI 路径（Store 政策 10.2.9）下，NSIS 安装器可自由写
  注册表注册右键菜单；MSIX 路径另说。
