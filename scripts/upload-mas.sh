#!/usr/bin/env bash
#
# 上传 Mac App Store .pkg 到 App Store Connect。
#
# 用法一：App Store Connect API Key（推荐）
#   APP_STORE_CONNECT_API_KEY="ABC123DEFG" \
#   APP_STORE_CONNECT_API_ISSUER="00000000-0000-0000-0000-000000000000" \
#   APP_STORE_CONNECT_API_KEY_PATH="$HOME/.private_keys/AuthKey_ABC123DEFG.p8" \
#   ./scripts/upload-mas.sh
#
# 用法二：Apple ID + app-specific password
#   APPLE_ID="you@example.com" \
#   APPLE_APP_PASSWORD="@keychain:MY_ALTOOL_PASSWORD" \
#   APPLE_PROVIDER_PUBLIC_ID="optional-provider-id" \
#   ./scripts/upload-mas.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG_PATH="${1:-$ROOT_DIR/dist-mas/markio.pkg}"

if [[ ! -f "$PKG_PATH" ]]; then
  echo "找不到 pkg：$PKG_PATH" >&2
  echo "请先运行 ./scripts/build-mas.sh" >&2
  exit 1
fi

if [[ -n "${APP_STORE_CONNECT_API_KEY:-}" && -n "${APP_STORE_CONNECT_API_ISSUER:-}" ]]; then
  cmd=(
    xcrun altool
    --upload-package "$PKG_PATH"
    --api-key "$APP_STORE_CONNECT_API_KEY"
    --api-issuer "$APP_STORE_CONNECT_API_ISSUER"
  )
  if [[ -n "${APP_STORE_CONNECT_API_KEY_PATH:-}" ]]; then
    cmd+=(--p8-file-path "$APP_STORE_CONNECT_API_KEY_PATH")
  fi
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
  cmd=(
    xcrun altool
    --upload-package "$PKG_PATH"
    --username "$APPLE_ID"
    --password "$APPLE_APP_PASSWORD"
  )
  if [[ -n "${APPLE_PROVIDER_PUBLIC_ID:-}" ]]; then
    cmd+=(--provider-public-id "$APPLE_PROVIDER_PUBLIC_ID")
  fi
else
  cat >&2 <<'EOF'
缺少 App Store Connect 上传凭据。

请设置以下任意一组环境变量后重试：

1) API Key:
   APP_STORE_CONNECT_API_KEY
   APP_STORE_CONNECT_API_ISSUER
   APP_STORE_CONNECT_API_KEY_PATH（可选；默认会按 altool 规则查找 AuthKey_*.p8）

2) Apple ID:
   APPLE_ID
   APPLE_APP_PASSWORD（建议使用 app-specific password 或 @keychain:xxx）
   APPLE_PROVIDER_PUBLIC_ID（多团队账号时需要）
EOF
  exit 2
fi

echo "==> 上传到 App Store Connect：$PKG_PATH"
"${cmd[@]}"
