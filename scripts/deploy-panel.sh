#!/usr/bin/env bash
# 把插件装进某个 panel-llrt 实例的插件目录。
#
#   面板提供面板，插件归插件项目 —— 所以"上线"这一步在插件项目里做，面板仓不参与
#   （面板仓的 plugins/ 里不该有 mcloud*.js / mcloud.webui/）。
#
# 用法：
#   npm run deploy:panel                                  # 默认日常实例 ~/panel-3030/plugins
#   PANEL_PLUGINS_DIR=/path/to/plugins npm run deploy:panel
#   npm run deploy:panel -- --restart                     # 装完顺手重启 launchd 服务
#
# 只做四件事：构建 → 样式门禁 → 整份拷贝（逐个对）→ 告诉你怎么让它生效。
# 不碰面板的数据目录，也不碰账号配置（账号在 <data>/plugin-data/mcloud/ 的本地 JSON 里，
# 插件首次启动会从面板库的 state 表**搬一次**，之后不再读写它）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="${PANEL_PLUGINS_DIR:-$HOME/panel-3030/plugins}"
DIST="$ROOT/dist/panel-llrt"
# 四个插件 + 一份界面（mcloud 是服务插件，其余三个各跑一类任务，共用同一份 webui）
PLUGINS=(mcloud mcloud-daily mcloud-exchange mcloud-live)
WEBUI_FILES=(index.html style.css app.js boot.js)
# 目录式产物：<name>/index.js + <name>/lib/**（mcloud 里是唯一一份核心）
DIRS=(mcloud mcloud-daily mcloud-exchange mcloud-live)
# 清单（<name>.panel.json）：面板靠它出配置表单、核对 min_panel
MANIFESTS=(mcloud.panel.json mcloud-daily.panel.json mcloud-exchange.panel.json mcloud-live.panel.json)
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "不认识的参数：$arg" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

# 产物形状：面板支持「目录式插件」（`plugins/<name>/index.js` + 相对 import）时
# 出**共用核心**的目录形态（四个插件 import 同一份 lib/，只有一份核心）；
# 不支持时退回单文件（四个包各自内联，行为一致，只是体积大）。
#
# 判据**必须真起一次**：多文件插件是 2026-11-16 才进面板的（commit 9af5403），
# 而 `panel version` 那会儿没变号（还是 0.5.1）；字符串也判不了 ——
# 静态链接的 release 二进制里搜不到那句中文常量（实测新旧两个都"搜不到"，
# 但旧的那个不认 ../ 跨目录 import）。所以用 scripts/panel-supports-dir-plugins.sh
# 起一个临时实例、装一个最小目录插件，看它能不能加载。
PANEL_BIN_FILE="${PANEL_BIN_FILE:-$(dirname "$DEST")/panel}"
MULTIFILE=0
if [ "${MCLOUD_PKG:-auto}" = "auto" ] && [ -x "$PANEL_BIN_FILE" ]; then
  if bash "$HERE/panel-supports-dir-plugins.sh" "$PANEL_BIN_FILE"; then
    MULTIFILE=1
  else
    echo "（探测：$PANEL_BIN_FILE 不支持目录式插件 —— 或者这次探测没起来）"
  fi
fi
if [ "${MCLOUD_PKG:-auto}" = "single" ] || { [ "${MCLOUD_PKG:-auto}" = "auto" ] && [ "$MULTIFILE" = 0 ]; }; then
  echo "→ 产物形状：单文件（面板「$PANEL_BIN_FILE」没有多文件插件能力）"
  node scripts/build.mjs
else
  echo "→ 产物形状：目录式 + 共用核心"
  node scripts/build-dir.mjs
fi

# 状态键门禁：`store/keys.ts` 的 KEY_SCOPE 漏登记会让**运行期**抛
# `UnregisteredKeyError`（2026-11-15 08:00 现场：三个账号的「分享领奖」全挂在这上面，
#  原因是实例里跑的包是从"登记还没进仓库"那一刻构建的）。
# 这道闸在**构建之后、安装之前**跑，扫的是 src —— 部署永远从当前源码构建，所以够用。
echo "→ 状态键门禁（test/keys.test.ts）"
node --test test/keys.test.ts >/tmp/mcloud-keys-gate.log 2>&1 || {
  echo "❌ 状态键没登记全，没装（详见 /tmp/mcloud-keys-gate.log）" >&2
  tail -5 /tmp/mcloud-keys-gate.log >&2
  exit 1
}

# 样式门禁：面板仓的 check-plugin-style.mjs 按 <cwd>/plugins 扫，所以把产物在临时目录里
# 摆成插件目录再跑它 —— "插件归插件项目"之后这道闸门也没丢。
PANEL_REPO="${PANEL_REPO:-$ROOT/../panel-llrt}"
GATE="$PANEL_REPO/scripts/check-plugin-style.mjs"
if [ -f "$GATE" ]; then
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/plugins"
  cp -R "$DIST/." "$TMP/plugins/"
  echo "→ 样式门禁（$GATE）"
  ( cd "$TMP" && node "$GATE" ) || { rm -rf "$TMP"; echo "❌ 样式门禁没过，没装" >&2; exit 1; }
  rm -rf "$TMP"
else
  echo "（跳过样式门禁：没找到 $GATE）"
fi

if [ ! -d "$DEST" ]; then
  echo "❌ 插件目录不存在：$DEST（面板装过吗？或者用 PANEL_PLUGINS_DIR 指定）" >&2
  exit 1
fi

# 装之前先留一份旧的（装坏了能立刻换回来：mv 回去 + 重载插件）
# ⚠ 备份放到插件目录**外面**（`<实例>/backups/`）：plugins/ 是面板要扫的目录，
#   往里面塞备份目录会让文件列表多出莫名其妙的东西。
BK="$(dirname "$DEST")/backups/mcloud-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
for n in "${PLUGINS[@]}"; do [ -f "$DEST/$n.js" ] && cp "$DEST/$n.js" "$BK/"; [ -d "$DEST/$n" ] && cp -R "$DEST/$n" "$BK/"; done
[ -d "$DEST/mcloud.webui" ] && cp -R "$DEST/mcloud.webui" "$BK/"
for f in "${MANIFESTS[@]}"; do [ -f "$DEST/$f" ] && cp "$DEST/$f" "$BK/"; done
echo "→ 旧的一套装在 $BK"

echo "→ 装到 $DEST"
# 先清掉**另一种形状**的旧产物，免得更新的插件发现"两个都在"（面板先看 <name>.js）
for n in "${PLUGINS[@]}"; do rm -rf "${DEST:?}/$n.js" "${DEST:?}/$n"; done
if [ -d "$DIST/mcloud" ]; then
  for n in "${DIRS[@]}"; do cp -R "$DIST/$n" "$DEST/$n"; done
else
  for n in "${PLUGINS[@]}"; do cp "$DIST/$n.js" "$DEST/$n.js"; done
fi
rm -rf "${DEST:?}/mcloud.webui"
cp -R "$DIST/mcloud.webui" "$DEST/mcloud.webui"
for f in "${MANIFESTS[@]}"; do cp "$DIST/$f" "$DEST/$f"; done

if [ -d "$DIST/mcloud" ]; then
  for n in "${DIRS[@]}" mcloud.webui; do diff -r "$DIST/$n" "$DEST/$n"; done
else
  for n in "${PLUGINS[@]}"; do cmp "$DIST/$n.js" "$DEST/$n.js"; done
fi
for f in "${MANIFESTS[@]}"; do cmp "$DIST/$f" "$DEST/$f"; done
for f in "${WEBUI_FILES[@]}"; do cmp "$DIST/mcloud.webui/$f" "$DEST/mcloud.webui/$f"; done
echo "✅ $(( ${#PLUGINS[@]} + ${#WEBUI_FILES[@]} )) 个文件逐个 cmp 一致"

if [ "$RESTART" = 1 ]; then
  echo "→ 重启 launchd 服务（${PANEL_LABEL:-dev.panel}）"
  launchctl kickstart -k "gui/$(id -u)/${PANEL_LABEL:-dev.panel}"
  # ⚠ **装完必须自己看一眼加载结果**（2026-11-16 撞了两次）：
  #   · 目录式产物要是把 npm 包（fflate）留成裸 import ⇒ 加载期 "Error resolving module"
  #   · 或者产物里还留着 `.ts` 说明符 ⇒ "import 的文件不存在"
  #   两种都表现为"面板起来了、但某个插件是灰的"，而 zip/cmp 全绿。
  BASE_URL="${PANEL_BASE_URL:-http://127.0.0.1:3030}"
  for i in $(seq 1 20); do
    sleep 1
    READY="$(curl -fsS -m 2 "$BASE_URL/readyz" 2>/dev/null || true)"
    [ -n "$READY" ] && break
  done
  echo "   readyz: ${READY:-（连不上）}"
  if printf '%s' "${READY:-}" | grep -q '"failed_plugins":0'; then
    echo "✅ 已重启：没有加载失败的插件"
  else
    echo "❌ 有插件没加载起来 —— 最近日志：" >&2
    sqlite3 "$HOME/panel-3030/data/panel.db" \
      "select plugin, level, substr(message,1,240) from logs where level in ('error','warn') order by id desc limit 8" >&2 2>/dev/null || true
    exit 1
  fi
else
  cat <<'TIP'

下一步（二选一让它生效）：
  · 面板界面 → 插件列表 → mcloud 卡片 → 「重载」（只影响这一个插件；四个要各点一次）
  · 或重来一次带 --restart（重启整个面板服务）
TIP
fi