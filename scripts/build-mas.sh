#!/usr/bin/env bash
#
# Mac App Store 打包脚本：生成 .app → 沙盒签名 → 打包成 .pkg
# 上传用 Xcode 自带的 Transporter（或 xcrun altool / notarytool）
#
# 用前先准备：
#   1. 在 Apple Developer 后台创建 App ID `com.welape.mdview`，勾上 `App Sandbox`
#   2. 申请 “Mac App Distribution” 证书（用于 .app）+ “Mac Installer Distribution” 证书（用于 .pkg）
#   3. 在 App Store Connect 里建好对应应用记录
#   4. 把两个证书都装到 macOS 钥匙串
#
# 调用方式：
#   APPLE_SIGNING_IDENTITY="3rd Party Mac Developer Application: …" \
#   APPLE_INSTALLER_IDENTITY="3rd Party Mac Developer Installer: …" \
#   APPLE_TEAM_ID="ABCDE12345" \
#   PROVISIONING_PROFILE=path/to/markio_mas.provisionprofile \
#   ./scripts/build-mas.sh
#
# 输出：
#   src-tauri/target/universal-apple-darwin/release/bundle/macos/markio.app  （签好）
#   dist-mas/markio.pkg                                                      （上传 Transporter）

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="markio"
BUNDLE_ID="com.welape.mdview"

: "${APPLE_SIGNING_IDENTITY:?需要设置 APPLE_SIGNING_IDENTITY（Mac App Distribution 证书）}"
: "${APPLE_INSTALLER_IDENTITY:?需要设置 APPLE_INSTALLER_IDENTITY（Mac Installer Distribution 证书）}"
: "${APPLE_TEAM_ID:?需要设置 APPLE_TEAM_ID}"

# MAS 专用 entitlements：不含 apple-events（temporary-exception 在 MAS 无法授权）。
BASE_ENTITLEMENTS="$ROOT_DIR/src-tauri/entitlements/macos.mas.entitlements"
INHERIT_ENTITLEMENTS="$ROOT_DIR/src-tauri/entitlements/macos.inherit.entitlements"
DIST_DIR="$ROOT_DIR/dist-mas"
MAS_ENTITLEMENTS="$DIST_DIR/macos.mas.entitlements"

mkdir -p "$DIST_DIR"
cp "$BASE_ENTITLEMENTS" "$MAS_ENTITLEMENTS"
/usr/libexec/PlistBuddy -c "Delete :com.apple.application-identifier" "$MAS_ENTITLEMENTS" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Delete :com.apple.developer.team-identifier" "$MAS_ENTITLEMENTS" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :com.apple.application-identifier string ${APPLE_TEAM_ID}.${BUNDLE_ID}" "$MAS_ENTITLEMENTS"
/usr/libexec/PlistBuddy -c "Add :com.apple.developer.team-identifier string ${APPLE_TEAM_ID}" "$MAS_ENTITLEMENTS"
ENTITLEMENTS="$MAS_ENTITLEMENTS"

# 给嵌套 helper / framework 用的"继承"型 entitlements
if [[ ! -f "$INHERIT_ENTITLEMENTS" ]]; then
  cat > "$INHERIT_ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key><true/>
    <key>com.apple.security.inherit</key><true/>
</dict>
</plist>
PLIST
fi

echo "==> 1. 构建前端 + 通用二进制（aarch64 + x86_64）"
cd "$ROOT_DIR"
pnpm install --frozen-lockfile
# 让前端编译期裁掉沙盒下无法合规的 macOS 系统集成功能（Apple Notes 导入 / 系统分享）
export VITE_MARKIO_MAS=1
# externalBin 置空：预览器 markio-preview 是独立无沙盒设计，不能进 MAS 沙盒包
# （否则会被签上 inherit 沙盒；且 universal 包还需 universal sidecar）。仅直发包带它。
pnpm tauri build --target universal-apple-darwin --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false,"externalBin":[]}}'

APP_PATH="$ROOT_DIR/src-tauri/target/universal-apple-darwin/release/bundle/macos/${APP_NAME}.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "构建产物没找到：$APP_PATH" >&2
  exit 1
fi

if [[ -n "${PROVISIONING_PROFILE:-}" ]]; then
  echo "==> 2. 嵌入 provisioning profile"
  cp "$PROVISIONING_PROFILE" "$APP_PATH/Contents/embedded.provisionprofile"
fi

echo "==> 清理 macOS 下载隔离扩展属性"
/usr/bin/xattr -cr "$APP_PATH"

echo "==> 3. 给所有嵌套 framework / helper 签名（inherit）"
# 从内到外签
find "$APP_PATH/Contents" -type d -name "*.framework" -print0 | while IFS= read -r -d '' fw; do
  /usr/bin/codesign --force --options runtime --timestamp \
    --entitlements "$INHERIT_ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" "$fw"
done

# Helpers / XPC / Plugins 等附属可执行
find "$APP_PATH/Contents/MacOS" -mindepth 1 -type f -print0 | while IFS= read -r -d '' bin; do
  if [[ "$bin" == "$APP_PATH/Contents/MacOS/$APP_NAME" ]]; then
    continue
  fi
  /usr/bin/codesign --force --options runtime --timestamp \
    --entitlements "$INHERIT_ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" "$bin"
done

echo "==> 4. 给主可执行 + .app 签名（带正式 entitlements）"
/usr/bin/codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$APPLE_SIGNING_IDENTITY" \
  "$APP_PATH/Contents/MacOS/$APP_NAME"

/usr/bin/codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$APPLE_SIGNING_IDENTITY" "$APP_PATH"

echo "==> 5. 验证签名"
/usr/bin/codesign --verify --strict --verbose=2 "$APP_PATH"

echo "==> 6. 打包成 .pkg"
PKG_PATH="$DIST_DIR/${APP_NAME}.pkg"
/usr/bin/productbuild \
  --component "$APP_PATH" /Applications \
  --sign "$APPLE_INSTALLER_IDENTITY" \
  "$PKG_PATH"

echo "==> 完成：$PKG_PATH"
echo "用 Xcode → Window → Organizer → Apps（或 Transporter）上传到 App Store Connect"
