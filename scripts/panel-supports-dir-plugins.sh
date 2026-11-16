#!/usr/bin/env bash
# 探测某个面板二进制是否支持「目录式插件」（plugins/<name>/index.js + 相对 import）。
#   用法：panel-supports-dir-plugins.sh /path/to/panel [port]
#   退出码 0 = 支持；1 = 不支持（含起不来/超时）
# 为什么要真起一次：这个能力是 2026-11-16 才进的，而 `panel version` 那会儿**没变号**
# （还是 0.5.1），靠版本号分不出来。字符串也不好判 —— 静态链接 + 中文常量，
# grep 的结果和实际行为对不上（见 docs/findings.md F-141）。
set -uo pipefail
BIN="${1:?用法: $0 /path/to/panel [port]}"
PORT="${2:-18979}"
TMP="$(mktemp -d)"
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

[ -x "$BIN" ] || { echo "不是可执行文件：$BIN" >&2; exit 1; }
mkdir -p "$TMP/data" "$TMP/plugins/probe/lib"
printf '{"server":{"bind":"127.0.0.1:%s"}}' "$PORT" > "$TMP/data/config.json"
printf "import './lib/a.js';\n" > "$TMP/plugins/probe/index.js"
printf "import host from 'panel:host';\nawait host.info('probe ok');\n" > "$TMP/plugins/probe/lib/a.js"

PANEL_DATA_DIR="$TMP/data" PANEL_PLUGINS_DIR="$TMP/plugins" PANEL_TOKEN=probe \
  PANEL_ALLOW_PLAIN_TOKEN=1 "$BIN" > "$TMP/panel.log" 2>&1 &
PID=$!

for _ in $(seq 1 20); do
  sleep 0.5
  out="$(curl -fsS -m 1 -H 'X-Panel-Token: probe' "http://127.0.0.1:$PORT/api/state" 2>/dev/null)" || continue
  # 插件在列表里、且没有 error ⇒ 目录形态 + 相对 import 都通了
  if printf '%s' "$out" | grep -q '"name":"probe"' && ! printf '%s' "$out" | grep -q '"name":"probe","error":"'; then
    exit 0
  fi
done
exit 1
