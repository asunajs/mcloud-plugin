#!/usr/bin/env bash
# 把面板二进制装进正在跑的实例 —— 带**必需**的 ad-hoc 签名。
#
# ⚠ 为什么必须有这一步：2026-11-16 现场，`cp` 覆盖二进制后 launchd 起不来，
#   `last exit reason = OS_REASON_CODESIGNING`（macOS 认为签名和内容对不上，
#   直接杀掉）。表现是面板整个不可用、日志里一行都没有。
#   装完必须 `codesign --force --sign -` 重新 ad-hoc 签名，否则一定起不来。

set -euo pipefail

SRC="${1:-$HOME/mobile/workspace/panel-llrt/target/release/panel}"
DST_DIR="${2:-$HOME/panel-3030}"
LABEL="${3:-dev.panel}"

[ -x "$SRC" ] || { echo "❌ 找不到可用的二进制：$SRC（先 cargo build --release）" >&2; exit 1; }
[ -d "$DST_DIR" ] || { echo "❌ 没有这个实例目录：$DST_DIR" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -x "$DST_DIR/panel" ]; then
  cp -p "$DST_DIR/panel" "$DST_DIR/panel.bak-$STAMP"
  echo "→ 旧的备份在 $DST_DIR/panel.bak-$STAMP"
fi

cp "$SRC" "$DST_DIR/panel"
xattr -d com.apple.quarantine "$DST_DIR/panel" 2>/dev/null || true
codesign --force --sign - "$DST_DIR/panel" >/dev/null 2>&1 || {
  echo "❌ ad-hoc 签名失败 —— 现在装上去会起不来（OS_REASON_CODESIGNING）" >&2
  exit 1
}
echo "→ 已装并签名"

launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || {
  echo "（没有 launchd 服务 $LABEL，跳过重启；手动起吧）"; exit 0
}

for _ in $(seq 1 15); do
  sleep 1
  if curl -fsS -m 2 http://127.0.0.1:3030/readyz >/dev/null 2>&1; then
    echo "✅ 面板已就绪：$(curl -fsS -m 2 http://127.0.0.1:3030/readyz)"
    exit 0
  fi
done
echo "❌ 15 秒内没就绪，看日志：$DST_DIR/data/panel.out.log" >&2
exit 1
