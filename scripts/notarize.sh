#!/usr/bin/env bash
#
# 直发渠道用：把 markio.app 公证（notarize）+ stapler 打钉，得到一份不在 App Store 也能开的安装包。
# App Store 包不需要这步——MAS 走 productbuild + Transporter。
#
# 用前要：
#   1. 用开发者账户登 https://appleid.apple.com 创建 App-Specific Password
#   2. xcrun notarytool store-credentials "markio-notary" \
#         --apple-id "you@example.com" --team-id "ABCDE12345" --password "xxxx-xxxx-xxxx-xxxx"
#   3. APPLE_SIGNING_IDENTITY 用 “Developer ID Application: …” 证书（不是 MAS 的那张）
#
# 用法：
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …" ./scripts/notarize.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="markio"

: "${APPLE_SIGNING_IDENTITY:?需要 APPLE_SIGNING_IDENTITY（Developer ID Application 证书）}"
NOTARY_PROFILE="${NOTARY_PROFILE:-markio-notary}"
ENT="$ROOT_DIR/src-tauri/entitlements/macos.dev.entitlements"

cd "$ROOT_DIR"
pnpm tauri build --target universal-apple-darwin --bundles dmg

DMG="$ROOT_DIR/src-tauri/target/universal-apple-darwin/release/bundle/dmg/${APP_NAME}_0.1.0_universal.dmg"

echo "==> 公证 $DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> 给 DMG 打钉"
xcrun stapler staple "$DMG"

echo "==> 验证"
spctl -a -t open --context context:primary-signature -vv "$DMG"

echo "==> 完成：$DMG"
