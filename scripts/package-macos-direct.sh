#!/usr/bin/env bash
# macOS 直发包打包：构建主 app（含 externalBin 注入的预览器二进制）→ 嵌入独立
# "Markio Preview.app"（实现右键"打开方式"/双击预览）→ 可选签名 + 公证 → 打 DMG。
#
#   scripts/package-macos-direct.sh <target-triple>
#     target-triple: aarch64-apple-darwin | x86_64-apple-darwin
#
# 可选签名/公证（直发包需要；不给则产未签名 DMG，仅供本地测试）：
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …"
#   APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID  （notarytool 公证用）
#
# 输出 DMG 路径打印在最后一行 "DMG=" 供 CI 上传。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TARGET="${1:?用法: package-macos-direct.sh <target-triple>}"
VERSION="$(node -p "require('./package.json').version")"
ARCH="${TARGET%%-*}"
APP_NAME="markio"

echo "==> 1. sidecar + 主 app（--bundles app）"
node scripts/prep-preview-sidecar.mjs "$TARGET"
pnpm tauri build --target "$TARGET" --bundles app

APP="$ROOT/src-tauri/target/$TARGET/release/bundle/macos/$APP_NAME.app"
[[ -d "$APP" ]] || { echo "没找到构建产物：$APP" >&2; exit 1; }

echo "==> 2. 嵌入独立预览器并签名"
EMBED="$ROOT/src-tauri/crates/markio-preview/macos/embed-preview-app.sh"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  bash "$EMBED" "$APP" --sign "$APPLE_SIGNING_IDENTITY"
else
  bash "$EMBED" "$APP"
fi

echo "==> 3. 打 DMG"
OUT="$ROOT/dist-direct"
mkdir -p "$OUT"
DMG="$OUT/markio_${VERSION}_${ARCH}.dmg"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

# 公证整个 DMG 容器并 staple（行业标准：分发物是 DMG，需自带 notarization ticket）。
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  echo "==> 4. 公证 DMG（notarytool）"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$DMG"
fi

echo "完成"
echo "DMG=$DMG"
