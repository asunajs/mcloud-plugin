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
# 只做四件事：构建 → 样式门禁 → 整份拷贝（逐个 cmp）→ 告诉你怎么让它生效。
# 不碰面板的数据目录，也不碰账号配置（账号在面板库的 state 表里）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="${PANEL_PLUGINS_DIR:-$HOME/panel-3030/plugins}"
DIST="$ROOT/dist/panel-llrt"
# 四个插件 + 一份界面（mcloud 是服务插件，其余三个各跑一类任务，共用同一份 webui）
PLUGINS=(mcloud mcloud-daily mcloud-exchange mcloud-live)
WEBUI_FILES=(index.html style.css app.js boot.js)
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
node scripts/build-panelllrt.mjs

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
for n in "${PLUGINS[@]}"; do [ -f "$DEST/$n.js" ] && cp "$DEST/$n.js" "$BK/"; done
[ -d "$DEST/mcloud.webui" ] && cp -R "$DEST/mcloud.webui" "$BK/"
for f in "${MANIFESTS[@]}"; do [ -f "$DEST/$f" ] && cp "$DEST/$f" "$BK/"; done
echo "→ 旧的一套装在 $BK"

echo "→ 装到 $DEST"
for n in "${PLUGINS[@]}"; do cp "$DIST/$n.js" "$DEST/$n.js"; done
rm -rf "${DEST:?}/mcloud.webui"
cp -R "$DIST/mcloud.webui" "$DEST/mcloud.webui"
for f in "${MANIFESTS[@]}"; do cp "$DIST/$f" "$DEST/$f"; done

for n in "${PLUGINS[@]}"; do cmp "$DIST/$n.js" "$DEST/$n.js"; done
for f in "${MANIFESTS[@]}"; do cmp "$DIST/$f" "$DEST/$f"; done
for f in "${WEBUI_FILES[@]}"; do cmp "$DIST/mcloud.webui/$f" "$DEST/mcloud.webui/$f"; done
echo "✅ $(( ${#PLUGINS[@]} + ${#WEBUI_FILES[@]} )) 个文件逐个 cmp 一致"

if [ "$RESTART" = 1 ]; then
  echo "→ 重启 launchd 服务（${PANEL_LABEL:-dev.panel}）"
  launchctl kickstart -k "gui/$(id -u)/${PANEL_LABEL:-dev.panel}"
  echo "✅ 已重启；看日志确认真加载了："
  echo "   sqlite3 \"$HOME/panel-3030/data/panel.db\" \"select plugin, message from logs order by id desc limit 5\""
else
  cat <<'TIP'

下一步（二选一让它生效）：
  · 面板界面 → 插件列表 → mcloud 卡片 → 「重载」（只影响这一个插件；四个要各点一次）
  · 或重来一次带 --restart（重启整个面板服务）
TIP
fi
