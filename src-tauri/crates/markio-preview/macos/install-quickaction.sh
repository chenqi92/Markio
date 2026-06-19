#!/usr/bin/env bash
# 安装 / 卸载 Finder 快捷操作"Markio 预览"（右键 → 快捷操作）。
# 真实分发时由主 app 首次运行或安装器调用；这里也可手动跑。
#
#   install-quickaction.sh            安装到 ~/Library/Services
#   install-quickaction.sh --uninstall 卸载
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/quickaction/Markio 预览.workflow"
DEST_DIR="$HOME/Library/Services"
DEST="$DEST_DIR/Markio 预览.workflow"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$DEST"
  /System/Library/CoreServices/pbs -flush 2>/dev/null || true
  echo "已卸载快捷操作"
  exit 0
fi

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
# 刷新 Services 缓存，让右键菜单立即出现
/System/Library/CoreServices/pbs -flush 2>/dev/null || true
echo "已安装快捷操作到 $DEST"
echo "右键 .md 文件 → 快捷操作 → Markio 预览（首次可能需在'系统设置 → 键盘 → 快捷键 → 服务'里勾选）"
