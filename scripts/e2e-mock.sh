#!/usr/bin/env bash
# 对着 mock 上游跑一遍全套 —— **绝不碰真账号**，也不需要你的凭据。
#
# 用法：
#   ./scripts/e2e-mock.sh <面板可执行文件> [端口]
#
# 它做四件事：
#   ① 起 mock 上游（插件会被告知把上游指向它）
#   ② 起面板（PLUGINS_DIR 指向本仓库的 plugins/）
#   ③ 导入一份**假会话**，把上游基址指到 mock
#   ④ 逐条跑签到族任务，断言状态落盘 + mock 收到的字节
#
# 想手工看现场：脚本会把面板日志留在临时目录并打印路径。
# 想自己接着玩：脚本结束时不会杀掉面板与 mock（除非设置 E2E_KEEP=0）。

set -euo pipefail

PANEL_BIN="${1:?用法: scripts/e2e-mock.sh <面板可执行文件> [端口]}"
PANEL_PORT="${2:-18899}"
MOCK_PORT="$((PANEL_PORT + 100))"
TOKEN="e2e-mock-token"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"

# ⚠️ 头要用**数组**，不要用 `H="-H K:V"` 再 `curl "$H"` —— 加了引号那是一个参数，
# curl 的短选项解析会把 URL 当成头值（实测：不加引号能过、加了引号 400，
# 差别只在那对引号上）。写脚本时这里踩过一次，留个note。
H=(-H "X-Panel-Token:$TOKEN")
W=("${H[@]}" -H "x-panel:1")   # 写接口要 x-panel: 1（面板 CSRF，插件路由同样适用 —— 见 F-007）
B="http://127.0.0.1:$PANEL_PORT"

cleanup() {
  if [ "${E2E_KEEP:-1}" = "0" ]; then
    kill "${PANEL_PID:-0}" "${MOCK_PID:-0}" 2>/dev/null || true
  else
    echo "· 面板与 mock 还在跑（面板 PID ${PANEL_PID:-?}、mock PID ${MOCK_PID:-?}）"
    echo "· 要收摊：kill ${PANEL_PID:-0} ${MOCK_PID:-0}"
  fi
}
trap cleanup EXIT

echo "① 起 mock 上游（:$MOCK_PORT）"
node "$HERE/mock/upstream.mjs" "$MOCK_PORT" > "$TMP/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" >/dev/null 2>&1 && break
  sleep 0.3
done

echo "② 起面板（:$PANEL_PORT，PLUGINS_DIR=$HERE/plugins）"
BIND_ADDR="127.0.0.1:$PANEL_PORT" \
DB_PATH="$TMP/panel.db" \
PLUGINS_DIR="$HERE/plugins" \
PANEL_TOKEN="$TOKEN" \
  "$PANEL_BIN" > "$TMP/panel.log" 2>&1 &
PANEL_PID=$!

# 等**插件与它的任务**就位，不是等接口通（见 docs/findings.md F-003）
echo "   等插件装好…"
for i in $(seq 1 40); do
  curl -fsS "${H[@]}" "$B/api/state" -o "$TMP/state.json" 2>/dev/null || true
  python3 - "$TMP/state.json" <<'PY' && break
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
names = {j['name'] for j in s.get('jobs', []) if j.get('plugin') == 'mcloud'}
sys.exit(0 if {'task-list', 'prizes', 'sign', 'backup-gift', 'cloud-snapshot'} <= names else 1)
PY
  sleep 0.5
done

echo "③ 指向 mock + 导入假会话"
curl -fsS "${W[@]}" -X POST -d "{\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT\"}" "$B/plugins/mcloud/api/config"; echo
# 清空 mock 的请求记录要在**导入之前** —— 导入会立刻真验一次（打 infoV3），
# 那一次也是要断言的（它就是"体检"那一口）
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/_debug/requests/clear" > /dev/null
curl -fsS "${W[@]}" -X POST -d '{"session":"mockcookie=1"}' "$B/plugins/mcloud/api/session" > "$TMP/import.json"
python3 - "$TMP/import.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['verified'], '对 mock 的验证应当通过：' + str(d.get('note'))
assert 'mockcookie=1' not in json.dumps(d), '响应里不能回显凭据'
print('   会话导入并对 mock 验证通过，响应里没有凭据原文')
PY

echo "④ 逐条跑（备份好礼跑两次：先问、再领）"
for t in task-list prizes cloud-snapshot sign backup-gift; do
  curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/$t/run"
  printf '   %s ✓\n' "$t"
  sleep 0.5
done
curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/backup-gift/run"   # 第二次：真领
printf '   backup-gift（第二次）✓\n'
sleep 0.5

curl -fsS "${H[@]}" "$B/plugins/mcloud/api/tasks" -o "$TMP/plugin.json"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" -o "$TMP/mock.json"
python3 - "$TMP/plugin.json" "$TMP/mock.json" <<'PY'
import json, sys

d = json.load(open(sys.argv[1]))
errs = d.get('lastErrorByTask') or {}
assert not errs, '这些任务报了错：' + json.dumps(errs, ensure_ascii=False)

reqs = json.load(open(sys.argv[2]))
paths = {}
for r in reqs:
    paths.setdefault(r['path'].split('?')[0], []).append(r)
line = lambda p: paths.get(p, [None])[-1]

tl = line('/ycloud/signin/task/taskListV3')
assert tl and tl['body'] == '{"marketname":"sign_in_3","clientVersion":"12.6.0","group":""}', tl
assert line('/ycloud/signin/public/record')['path'] == (
    '/ycloud/signin/public/record?marketname=sign_in_3&type=1&pageNumber=1&pageSize=10')
assert line('/ycloud/signin/public/cloudRecordV2')['path'] == (
    '/ycloud/signin/public/cloudRecordV2?aiDou=1&type=0&pageNumber=1&pageSize=100')
assert line('/ycloud/signin/page/startSignIn')['path'].startswith('/ycloud/signin/page/startSignIn?client=app')
bi, br = line('/market/backupgift/info'), line('/market/backupgift/receive')
assert bi and br, '备份好礼两步没走完'
assert len(paths['/market/backupgift/receive']) == 1, '领一次就够，别重复领'
assert bi['headers']['activityid'] == 'backupgift', '备份好礼那页的 activityid 是 backupgift'
sess = line('/ycloud/signin/page/infoV3')
assert sess and sess['method'] == 'GET' and '?client=app' in sess['path'], sess
print('   ✅ 全部断言通过：query 逐字、备份好礼两步顺序正确、只领一次、没有任务报错')
print('   ✅ 面板日志：' + sys.argv[1].replace('plugin.json', 'panel.log'))
PY
