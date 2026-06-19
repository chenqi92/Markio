#!/usr/bin/env bash
# 把独立的 "Markio Preview.app" 嵌进主 markio.app 的 Contents/Library/ 下，
# 让 LaunchServices 发现它 → .md 右键"打开方式"出现 Markio Preview、双击可预览
# （触发经 Info.plist 的 Viewer 角色 + tao Event::Opened）。
#
#   embed-preview-app.sh <markio.app 路径> [--sign "Developer ID Application: ..."]
#
# 复用主 app 内由 externalBin 注入的 Contents/MacOS/markio-preview 二进制。
# 需在 `tauri build` 产出 .app 之后、打 DMG / 签主 app 之前调用（直发包流程）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:?用法: embed-preview-app.sh <markio.app> [--sign ID]}"
SIGN_ID=""
if [[ "${2:-}" == "--sign" ]]; then SIGN_ID="${3:-}"; fi

SIDECAR="$APP/Contents/MacOS/markio-preview"
[[ -x "$SIDECAR" ]] || { echo "主 app 内找不到 sidecar：$SIDECAR（externalBin 没注入？）" >&2; exit 1; }

PREV="$APP/Contents/Library/Markio Preview.app"
echo "嵌入 $PREV"
rm -rf "$PREV"
mkdir -p "$PREV/Contents/MacOS" "$PREV/Contents/Resources"
cp "$SCRIPT_DIR/Info.plist" "$PREV/Contents/Info.plist"
cp "$SIDECAR" "$PREV/Contents/MacOS/markio-preview"
[[ -f "$APP/Contents/Resources/icon.icns" ]] && cp "$APP/Contents/Resources/icon.icns" "$PREV/Contents/Resources/icon.icns" || true

if [[ -n "$SIGN_ID" ]]; then
  echo "签名（内→外）：$SIGN_ID"
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$PREV/Contents/MacOS/markio-preview"
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$PREV"
  # 主 app 内由 externalBin 注入的 sidecar 是独立 Mach-O，codesign 签 bundle 只签
  # CFBundleExecutable，必须单独签它，否则公证（notarytool）会拒整个 app。
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP/Contents/MacOS/markio-preview"
  # 嵌套 app 变更后，主 app 必须重签
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
else
  codesign --force --sign - "$APP/Contents/MacOS/markio-preview" 2>/dev/null || true
  codesign --force --sign - "$PREV" 2>/dev/null || true
  codesign --force --sign - "$APP" 2>/dev/null || true
fi
echo "完成：嵌套预览器已就位"
