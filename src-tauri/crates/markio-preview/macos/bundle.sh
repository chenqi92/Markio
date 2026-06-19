#!/usr/bin/env bash
# 把已编译的 markio-preview 二进制组装成 "Markio Preview.app"。
#
#   bundle.sh [输出目录] [--sign "Developer ID Application: ..."]
#
# 默认从 src-tauri/target/release/markio-preview 取二进制，输出到同目录。
# 直发包需要签名 + 公证；MAS 包另有沙盒/签名要求（见 README 备注）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TAURI="$(cd "$SCRIPT_DIR/../../.." && pwd)"   # macos -> markio-preview -> crates -> src-tauri

OUT="${1:-$SRC_TAURI/target/release}"
SIGN_ID=""
if [[ "${2:-}" == "--sign" ]]; then SIGN_ID="${3:-}"; fi

BIN="$SRC_TAURI/target/release/markio-preview"
ICON="$SRC_TAURI/icons/icon.icns"
APP="$OUT/Markio Preview.app"

if [[ ! -x "$BIN" ]]; then
  echo "找不到二进制：$BIN（先跑 cargo build --release -p markio-preview）" >&2
  exit 1
fi

echo "组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/markio-preview"
cp "$SCRIPT_DIR/Info.plist" "$APP/Contents/Info.plist"
[[ -f "$ICON" ]] && cp "$ICON" "$APP/Contents/Resources/icon.icns" || true

if [[ -n "$SIGN_ID" ]]; then
  echo "签名：$SIGN_ID"
  codesign --force --options runtime --timestamp \
    --sign "$SIGN_ID" "$APP/Contents/MacOS/markio-preview"
  codesign --force --options runtime --timestamp \
    --sign "$SIGN_ID" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
else
  # 本地测试用 ad-hoc 签名，便于 LaunchServices 正常注册
  codesign --force --sign - "$APP" 2>/dev/null || true
fi

echo "完成：$APP"
