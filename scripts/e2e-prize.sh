#!/usr/bin/env bash
# 领奖链（待领取 → 点领取 → 短信验证码 → 领取）在**真面板 + mock 上游**里跑一遍。
#
# 用法：
#   ./scripts/e2e-prize.sh <面板可执行文件> [端口]
#
# 它验的是**这一条链**，不是「插件能加载」：
#   ① mock 上游给一份待领取清单（2 件 flag=1、1 件 flag=2、1 件 flag=10）
#   ② 面板里读一次 → 必须只出 2 件、`flag` 过滤对、手机号已脱敏
#   ③ 点「领取」等价的那一枪 → 插件**自己解 JPEG 滑块**（答案 282）→ 发码
#      ⚠ 这一步会真跑 `src/crypto/jpeg.ts` + 轮廓匹配；mock 会拒绝偏差 >15 的偏移
#   ④ 提交 `MD5("123456")` → mock 翻 `flag` 为 2 → 列表少一件（命中缓存，不重打上游）
#
# ⚠ 全程只打 mock（127.0.0.1），**绝不碰真账号**；会话是假的、短信是 mock 的。
# ⚠ 面板要允许回环出站（`HOST_API_ALLOW_PRIVATE=1`）—— 否则会回「SSRF 防护拒绝」。
# ⚠ 这一条链会往**账号绑定的手机**发真短信；这里发的是 mock 的"验证码"，不会真发。

set -euo pipefail

PANEL_BIN="${1:?用法: scripts/e2e-prize.sh <面板可执行文件> [端口]}"
PANEL_PORT="${2:-18870}"
MOCK_PORT="$((PANEL_PORT + 100))"
TOKEN="e2e-prize-token"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"

PANEL_PID=""
MOCK_PID=""
H=(-H "X-Panel-Token:$TOKEN")
W=("${H[@]}" -H "x-panel:1")
B="http://127.0.0.1:$PANEL_PORT"

cleanup() {
  if [ "${E2E_KEEP:-1}" = "0" ]; then
    # ⚠ 不能写 `kill ${PID:-0}` —— 变量没设时 `kill 0` 会杀掉**整个进程组**
    if [ -n "$PANEL_PID" ]; then
      kill "$PANEL_PID" 2>/dev/null || true
      sleep 0.2
      kill -9 "$PANEL_PID" 2>/dev/null || true
    fi
    if [ -n "$MOCK_PID" ]; then
      kill "$MOCK_PID" 2>/dev/null || true
      sleep 0.2
      kill -9 "$MOCK_PID" 2>/dev/null || true
    fi
    # ⚠ 本机的 `node` 是 Volta 的 shim：`$!` 拿到的是 shim，真进程是它的子进程
    #   （shim 退出后子进程被 init 收养）。所以再按**端口**收一次尾。
    if command -v lsof >/dev/null 2>&1; then
      for port in "$PANEL_PORT" "$MOCK_PORT"; do
        pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
        if [ -n "$pids" ]; then
          kill $pids 2>/dev/null || true
          sleep 0.2
          kill -9 $pids 2>/dev/null || true
        fi
      done
    fi
  else
    echo "· 面板与 mock 还在跑（面板 PID ${PANEL_PID:-?}、mock PID ${MOCK_PID:-?}）"
    echo "· 要收摊：kill ${PANEL_PID:-0} ${MOCK_PID:-0}"
  fi
}
trap cleanup EXIT

for p in "$PANEL_PORT" "$MOCK_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/" 2>/dev/null; then
    echo "❌ 端口 $p 已被占用 —— 先收摊再跑：lsof -ti tcp:$p | xargs kill" >&2
    exit 2
  fi
done

echo "① 起 mock 上游（:$MOCK_PORT）"
node "$HERE/mock/upstream.mjs" "$MOCK_PORT" > "$TMP/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "② 起面板（:$PANEL_PORT，PLUGINS_DIR=$HERE/plugins）"
BIND_ADDR="127.0.0.1:$PANEL_PORT" \
DB_PATH="$TMP/panel.db" \
PLUGINS_DIR="$HERE/plugins" \
PANEL_TOKEN="$TOKEN" \
PANEL_ALLOW_PLAIN_TOKEN=1 \
HOST_API_ALLOW_PRIVATE=1 \
  "$PANEL_BIN" > "$TMP/panel.log" 2>&1 &
PANEL_PID=$!

echo "   等插件装好…"
for _ in $(seq 1 60); do
  curl -fsS "${H[@]}" "$B/api/state" -o "$TMP/state.json" 2>/dev/null || true
  python3 - "$TMP/state.json" <<'PY' && break
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
jobs = {(j.get('plugin'), j.get('name')) for j in s.get('jobs', [])}
want = {('mcloud-daily', '日常'), ('mcloud-exchange', '兑换'), ('mcloud-live', '直播')}
sys.exit(0 if want <= jobs else 1)
PY
  sleep 0.25
done

echo "③ 指向 mock + 加一个假账号 + 导入假会话（带 deviceId）"
curl -fsS "${W[@]}" -X POST -d "{\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT\"}" \
  "$B/plugins/mcloud/api/config" > /dev/null
# ⚠ 必须**先有账号**：领奖是按账号读的（没有账号时界面会说"还没选账号"）。
#   凭据是 `Basic base64("mobile:15900000000:token")` —— mock 不校验，只用来建号。
curl -fsS "${W[@]}" -X POST \
  -d '{"op":"add","auth":"Basic bW9iaWxlOjE1OTAwMDAwMDAwOnRva2Vu"}' \
  "$B/plugins/mcloud/api/accounts" > "$TMP/accounts.json"
python3 - "$TMP/accounts.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert len(d.get('accounts', [])) == 1, d
assert d['accounts'][0].get('current') is True, '第一条账号要自动选中：' + str(d)
print('   账号：', d['accounts'][0]['label'])
PY
curl -fsS "${W[@]}" -X POST \
  -d '{"session":"{\"cookie\":\"mockcookie=1\",\"jwt\":\"mock-jwttoken\",\"deviceId\":\"Bmock-device-000000000000000000000000000000000000000000000000000000000000000000000000000000000000\"}"}' \
  "$B/plugins/mcloud/api/session" > "$TMP/import.json"
python3 - "$TMP/import.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get('verified') is True, '对 mock 的验证应当通过：' + str(d.get('note'))
s = json.dumps(d)
assert 'mockcookie=1' not in s and 'mock-jwttoken' not in s, '响应里不能回显凭据'
PY

echo "④ 读待领取"
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/prizes" -o "$TMP/list.json"
python3 - "$TMP/list.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get('ok') is True, d
assert d.get('pending') == 2, 'flag=1 应当只有 2 件：' + str(d)
names = [x['name'] for x in d['items']]
assert '0.41元支付宝话费红包' in names, names
# flag=2 / flag=10 不许进来
assert '已经领过的会员月卡' not in names and '不知道哪一档（flag=10）' not in names, names
for x in d['items']:
    assert '****' in (x.get('phone') or ''), '手机号要脱敏：' + json.dumps(x, ensure_ascii=False)
s = json.dumps(d)
assert 'mock-jwttoken' not in s and 'mockcookie' not in s, '列表不许回显凭据'
assert 'Bmock-device' not in s, '列表不许回显 deviceId'
print('   待领取：', ' / '.join(names))
PY

ACC=$(python3 -c "import json;print(json.load(open('$TMP/list.json'))['account']['id'])")
OID=$(python3 -c "import json;print(json.load(open('$TMP/list.json'))['items'][0]['oid'])")

echo "⑤ 领取第一步：详情 → 取滑块（JPEG）→ 本地解 → 发验证码"
START=$(python3 -c 'import time;print(int(time.time()*1000))')
curl -fsS "${W[@]}" -X POST -d "{\"account\":\"$ACC\",\"oid\":\"$OID\"}" \
  "$B/plugins/mcloud/api/prizes/claim" -o "$TMP/claim.json"
END=$(python3 -c 'import time;print(int(time.time()*1000))')
python3 - "$TMP/claim.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get('ok') is True, '发码失败：' + json.dumps(d, ensure_ascii=False)
assert d.get('offset') == 282, '滑块答案应当是 282：' + json.dumps(d, ensure_ascii=False)
assert '验证码已发到' in d.get('note', ''), d
print('   offset=282，发码成功；', d['note'])
PY
echo "   这一枪（3 个请求 + 解码 + 解滑块）耗时 $(( END - START )) ms"

echo "⑥ 领取第二步：提交 MD5(验证码)"
curl -fsS "${W[@]}" -X POST \
  -d "{\"account\":\"$ACC\",\"oid\":\"$OID\",\"code\":\"123456\"}" \
  "$B/plugins/mcloud/api/prizes/confirm" -o "$TMP/confirm.json"
python3 - "$TMP/confirm.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get('ok') is True, '确认失败：' + json.dumps(d, ensure_ascii=False)
assert d.get('code') == 0, d
print('   ', d.get('note'))
PY

echo "⑦ 两端状态对得上"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/state" -o "$TMP/mock-state.json"
python3 - "$TMP/mock-state.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get('prizeSmsOffset') == 282, 'mock 收到的偏移不是 282：' + str(d.get('prizeSmsOffset'))
assert d.get('prizeAccepted'), 'mock 侧没有领取记录'
assert d['prizeRecords'][0]['flag'] == 2, '领成功后 flag 要翻 2：' + str(d['prizeRecords'][0])
print('   mock：offset=282，已领单号', d['prizeAccepted'], 'flag=2')
PY
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/prizes" -o "$TMP/list2.json"
python3 - "$TMP/list2.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get('pending') == 1, '领完应当只剩 1 件：' + str(d)
assert d.get('cached') is True, '这一步要命中缓存（不该重打上游）'
print('   再读：pending=1（来自缓存）')
PY

echo "⑧ 面板日志里没有凭据 / 验证码"
grep -q 'mock-jwttoken' "$TMP/panel.log" && { echo "❌ 面板日志里出现了 jwttoken"; exit 1; }
grep -q 'e10adc3949ba59abbe56e057f20f883e' "$TMP/panel.log" && { echo "❌ 面板日志里出现了验证码摘要"; exit 1; }
grep -q 'Bmock-device' "$TMP/panel.log" && { echo "❌ 面板日志里出现了 deviceId"; exit 1; }

echo "✅ 领奖链通过（列表 / 自动过滑块 / 发码 / MD5 验证码 / flag 翻转 / 缓存摘除）"
echo "· 现场：$TMP（panel.log / claim.json / confirm.json / mock-state.json）"
