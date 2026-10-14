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

# ⚠️ 端口被占就直接报错，别往下走。
# 吃过一次亏：上一次 KEEP=1 留下的进程还活着，于是脚本连到了**旧的** mock/面板，
# 断言结果是旧状态决定的（表现为"插件行为不对"，其实是环境不对）。
# 还有一次是 `pkill -f e2e-mock` 杀不掉 `node mock/upstream.mjs` —— 名字根本不匹配。
for p in "$PANEL_PORT" "$MOCK_PORT"; do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$p/" 2>/dev/null; then
    echo "❌ 端口 $p 已被占用 —— 可能是上一次跑剩的进程。先收摊再跑：" >&2
    echo "   lsof -ti tcp:$p | xargs kill" >&2
    exit 2
  fi
done

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
sys.exit(0 if {'task-list', 'prizes', 'sign', 'backup-gift', 'cloud-snapshot', 'notice'} <= names else 1)
PY
  sleep 0.5
done

echo "③ 指向 mock + 导入假会话"
curl -fsS "${W[@]}" -X POST -d "{\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT\"}" "$B/plugins/mcloud/api/config"; echo
# 清空 mock 的请求记录要在**导入之前** —— 导入会立刻真验一次（打 infoV3），
# 那一次也是要断言的（它就是"体检"那一口）
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/_debug/requests/clear" > /dev/null
curl -fsS "${W[@]}" -X POST \
  -d '{"session":"{\"cookie\":\"mockcookie=1\",\"jwt\":\"mock-jwttoken\"}"}' \
  "$B/plugins/mcloud/api/session" > "$TMP/import.json"
python3 - "$TMP/import.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['verified'], '对 mock 的验证应当通过：' + str(d.get('note'))
assert 'mockcookie=1' not in json.dumps(d), '响应里不能回显凭据'
# 假会话**要带 jwt**：领小红花那一族走 H5 公共头，凭据就是 `jwttoken`
# （没有它连一条都发不出去 —— 那不是"没登录"，是这一族本来就要票）
assert 'mock-jwttoken' not in json.dumps(d), 'jwt 也不能回显'
print('   会话导入并对 mock 验证通过，响应里没有凭据原文')
PY

echo "④ 逐条跑。多步任务**跑多次**让步骤机推进（一次调用只发一个请求是这套架构的纪律）"
for t in task-list prizes cloud-snapshot multiple revival backup-gift; do
  curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/$t/run"
  printf '   %s ✓\n' "$t"
  sleep 0.4
done
# 备份好礼：info 说能领 → 第二次才领
curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/backup-gift/run"
printf '   backup-gift（第二次：真领）✓\n'
# 签到：问状态 → 提交 → 回查（三段式）
for i in 1 2 3; do
  curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/sign/run"
  printf '   sign（第 %s 段）✓\n' "$i"
  sleep 0.4
done
# 领取：入队 → 逐条（清单里 2 条，第 2 条是延期领取会被跳过）
for i in 1 2 3; do
  curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/receive/run"
  printf '   receive（第 %s 次）✓\n' "$i"
  sleep 0.4
done
curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/receive/run"
printf '   receive（第 4 次：延期领取）✓\n'
sleep 0.4

# 通知任务：查两个槽 → 能领才领 → 下一轮**回查**（reward 不报到账数，成败只能靠回查）
for i in 1 2 3; do
  curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/notice/run"
  printf '   notice（第 %s 次）✓\n' "$i"
  sleep 0.4
done

# App 任务矩阵（**只读**）：一次读一个 group，连读 3 次要落到不同 group
for i in 1 2 3; do
  curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/app-task-matrix/run"
  printf '   app-task-matrix（第 %s 次）✓\n' "$i"
  sleep 0.3
done

# 兑换清单（**只读**）：一个 GET，不带 deviceId
curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/exchange-list/run"
printf '   exchange-list（只读）✓\n'
sleep 0.3

# 直播口令（**只读**）：抓的是**第三方页面**，所以先把它指到 mock 的 /xhs/profile
# —— 本仓库唯一会打外站的一条链。CI 里不指走的话它会去敲小红书（不稳，也不该）。
curl -fsS "${W[@]}" -X POST \
  -d "{\"liveUrl\":\"http://127.0.0.1:$MOCK_PORT/xhs/profile\"}" \
  "$B/plugins/mcloud/api/config" >/dev/null
curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/live-room/run"
printf '   live-room（只读，主页指到 mock）✓\n'
sleep 0.3

# ── 口令池（业务档，照 mcloud）：**再抓一次必须一个请求都不发** ──────────────
#
# 这一条是"30 分钟窗口"的端到端证据，判据是 **mock 侧没有新请求** ——
# 比"接口返回了 idle"有力得多（返回 idle 也可能只是文案对了）。
curl -fsS -o /dev/null "${W[@]}" -X POST "$B/api/tasks/mcloud/live-room/run"
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/live" -o "$TMP/live-pool.json"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" -o "$TMP/mock.json"
python3 - "$TMP/live-pool.json" "$TMP/mock.json" <<'PY'
import json, sys

pool = (json.load(open(sys.argv[1])) or {}).get('pool') or {}
hits = [r for r in json.load(open(sys.argv[2])) if r.get('path', '').startswith('/xhs/profile')]
assert len(hits) == 1, f'30 分钟窗口内不该再抓主页，实际抓了 {len(hits)} 次'
assert pool.get('validCount') == 0, pool
assert pool.get('stopScraping') is False, pool
assert pool.get('xhsWaitMs', 0) > 0, f'该报"还要等多久"：{pool}'
codes = {c['value']: c for c in pool.get('codes') or []}
# ⚠ 抓到了 ≠ 验过了：进池的状态必须是 **unknown**（唯一的验证途径是拿去领）
assert codes.get('云盘AI高效复盘', {}).get('state') == 'unknown', codes
assert codes['云盘AI高效复盘']['source'] == 'xiaohongshu', codes
print('   ✅ 口令池：抓到进池（未知）、30 分钟窗口内再抓一个请求都没发')
PY

curl -fsS "${H[@]}" "$B/plugins/mcloud/api/tasks" -o "$TMP/plugin.json"
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/live" -o "$TMP/live.json"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" -o "$TMP/mock.json"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/state" -o "$TMP/mock-state.json"
python3 - "$TMP/plugin.json" "$TMP/mock.json" "$TMP/mock-state.json" "$TMP/live.json" <<'PY'
import json, sys

d = json.load(open(sys.argv[1]))
errs = d.get('lastErrorByTask') or {}


def diagnose(msg):
    """断言失败时把现场打出来 —— 不然只能看到一句"期望 X 实际 Y"，
    还得回头翻日志、猜是哪一层的问题（我已经为此绕了好几个来回）。"""
    print('❌ ' + msg)
    print('  插件最近的记录：')
    for r in (json.load(open(sys.argv[1])).get('recent') or [])[:14]:
        print('    %-13s %s' % (r['task'], str(r['note'])[:90]))
    print('  各任务的失败原因：' + json.dumps(errs, ensure_ascii=False))
    print('  mock 收到的请求：')
    for r in json.load(open(sys.argv[2])):
        print('    %-4s %s' % (r['method'], r['path'][:90]))
    print('  mock 状态：' + json.dumps(json.load(open(sys.argv[3])), ensure_ascii=False))


assert not errs, diagnose('这些任务报了错')


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

# ── 最终状态：这一天才算真的过完 ────────────────────────────────────────
# 这些断言比"任务返回 ok"有力得多：它们看的是**上游侧的状态真的变了**。
mockst = json.load(open(sys.argv[3]))
assert mockst['todaySigned'] is True, '签到没有真正落地（mock 状态里今天还是没签）：' + str(mockst)
assert mockst['curMonthBackupSignAccept'] is True, '翻倍没领到'
# 清单要**清空**：两条都领到了（r1 走 receiveV3、r2 是延期领取走 receiveTaskExpansion）。
# 之前这里只断言"剩一条"—— 因为那时延期领取还没实现。现在能真清空了，就断言清空。
assert mockst['receiveList'] == [], '待领清单没清空：' + str(mockst['receiveList'])
# 延期领取那一口必须是**裸 GET**（带 ?acceptDate= 就是另一个请求）
rte = [r for r in reqs if 'receiveTaskExpansion' in r['path']]
assert rte, '没调用 receiveTaskExpansion'
assert rte[-1]['path'] == '/ycloud/signin/page/receiveTaskExpansion', (
    '延期领取应当是裸 GET：' + rte[-1]['path'])
assert mockst['backupCanReceive'] is False, '备份好礼没领到'

# 签到是三段式：先 infoV3（说没签）→ startSignIn → 再 infoV3（说签了）
# ⚠️ 大小写：端点里是 `startSignIn`（大写 S），别写成 `signIn` 去 in 一下 ——
# 那次我因此得到"插件没提交签到"的假象，白白绕了几个来回。
# 过滤器一律用路径片段 `/signin/`（全小写、两边都对得上）。
sig_seq = [r['path'].split('?')[0] for r in reqs if '/signin/' in r['path']]
if sig_seq.count('/ycloud/signin/page/startSignIn') != 1:
    diagnose('签到提交次数不是 1：' + str(sig_seq))
if sig_seq.count('/ycloud/signin/page/infoV3') < 2:
    diagnose('签到回查那一步没发生：' + str(sig_seq))
assert sig_seq.count('/ycloud/signin/page/startSignIn') == 1, '提交只该一次：' + str(sig_seq)
assert sig_seq.count('/ycloud/signin/page/infoV3') >= 2, '回查那一步没发生：' + str(sig_seq)

print('   ✅ 全部断言通过：query 逐字、备份好礼两步、签到三段式（含回查）、')
print('      翻倍门槛、逐条领取、只领一次、没有任务报错 —— 且 mock 侧状态真的变了')
print('   ✅ 面板日志：' + sys.argv[1].replace('plugin.json', 'panel.log'))
PY

# 通知任务：`reward` **只该发一次**（它真的会入账），且 mock 侧状态必须真的变了
python3 - "$TMP/mock.json" "$TMP/mock-state.json" <<'PY'
import json, sys
reqs = json.dumps(json.load(open(sys.argv[1])), ensure_ascii=False)
st = json.load(open(sys.argv[2]))
info_n = reqs.count('getTaskInfo')
reward_n = reqs.count('/openEmailsms/reward')
assert info_n >= 2, f'通知任务该查过至少两次状态（第二次是回查），实际 {info_n}'
assert reward_n == 1, f'reward 只该发一次（会真入账），实际 {reward_n}'
assert st.get('noticeClaimable') is False, f'mock 侧状态没变：{st.get("noticeClaimable")}'
print('   ✅ 通知任务：查过状态、只领一次、mock 侧真的变成已领')
PY

# App 任务矩阵：游标真的在推进（三次读到两个市场）、**只走 V3**，且只碰只读端点
#
# ⚠ 这条断言原先数的是 `taskListV2` —— 那是**陈旧视图**（F-025：真机 App 那一趟
#   只调 V3；548/550/1078 就是从 V2 的列表里来的）。插件改成只走 V3 之后，
#   这条断言就一直在数一个**根本不该出现的路径** ⇒ 恒为 0 ⇒ e2e 红。
#   现在它同时钉住"改了 V3"与"没再回到 V2"两件事。
python3 - "$TMP/mock.json" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
hits = [r for r in reqs if 'taskListV3' in r.get('path', '')]
assert len(hits) >= 3, f'矩阵该读至少三次，实际 {len(hits)}'
assert not [r for r in reqs if 'taskListV2' in r.get('path', '')], '列表**只走 V3**（V2 是陈旧视图，548/550/1078 出自它）'
# ⚠ 逐条读 body，别用 json.dumps 之后的整串去 find —— 那样引号是转义的，
#   我自己第一版就栽在这儿（断言写错，代码是对的）。
bodies = []
for r in hits:
    try:
        bodies.append(json.loads(r.get('body') or '{}'))
    except Exception:
        bodies.append({})
assert all(b.get('group') == '' for b in bodies), f'V3 的 group 必须是**空串**：{[b.get("group") for b in bodies]}'
markets = [b.get('marketname') for b in bodies]
assert all(markets[:3]), f'前三次都该带 marketname，实际 {markets[:3]}'
assert len(set(markets[:3])) == 2, f'游标该在两个市场之间轮转：{markets[:3]}'
assert all(r.get('method') == 'POST' for r in hits), '这一口是 POST'
print('   ✅ App 任务矩阵：只读、只走 V3（group 空串）、两个市场轮转')
PY

# 兑换清单：只读 —— 只有 GET，且不带 deviceId（实拍就是这样）
python3 - "$TMP/mock.json" <<'PY'
import json, sys
hits = [r for r in json.load(open(sys.argv[1])) if 'exchangeList' in r.get('path', '')]
assert len(hits) == 1, f'该只读一次，实际 {len(hits)}'
assert hits[0].get('method') == 'GET', hits[0].get('method')
assert 'deviceId' not in hits[0].get('path', ''), '这一口不带 deviceId'
print('   ✅ 兑换清单：只读、一个 GET、不带 deviceId')
PY

# 直播口令：只读 —— 一个 GET 打第三方"主页"，UA 伪装在，且解析出的是那一条口令。
# 这一条把整条链（公开 GET → 四级候选 → 逐字移植的提取器）在**真面板**里走通了。
python3 - "$TMP/mock.json" "$TMP/live.json" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
hits = [r for r in reqs if r.get('path', '').startswith('/xhs/profile')]
assert len(hits) == 1, f'该只抓一次主页，实际 {len(hits)}'
assert hits[0].get('method') == 'GET', hits[0].get('method')
# UA 伪装丢了会被回空壳页，而空壳与"这期没发"在解析层分不开 ⇒ 这条断言是必须的
assert 'Chrome' in (hits[0].get('headers') or {}).get('user-agent', ''), 'UA 伪装丢了'

live = json.load(open(sys.argv[2]))
assert live.get('reading'), '没有读数（任务没落盘？）'
assert live['reading']['codes'] == ['云盘AI高效复盘'], live['reading']['codes']
assert live['reading']['url'].endswith('/xhs/profile'), live['reading']['url']
# 页面是 mock 造的大页面 ⇒ 不该触发"页面小得可疑"那条猜测
assert live['reading']['chars'] > live['emptyShellHintChars'], live['reading']['chars']
assert live.get('codes') is None, '还没存过人给的口令，这里该是 null'
print('   ✅ 直播口令：只读、一个 GET、UA 伪装在、解出了那一条口令')
PY

# ── 领小红花（**写那半**）：六步链端到端跑一遍 ──────────────────────────────
#
# 这里用的是**界面那条路**：浏览器循环调 `/api/live/draw/step`，每次一步、每次一个
# 上游请求（面板单次执行预算只有 2000ms，跑完一整条链会被判超时，而那时账已经记了）。
# 脚本里就用 for 循环扮演那个浏览器。
echo "⑤ 领小红花（写）：先存口令，再一步步推完"
curl -fsS -o /dev/null "${W[@]}" -X POST -H 'content-type: application/json' \
  -d '{"codes":"云盘AI高效复盘\n过期的口令"}' "$B/plugins/mcloud/api/live/codes"
curl -fsS -o /dev/null "${W[@]}" -X POST "$B/plugins/mcloud/api/live/claim" \
  -H 'content-type: application/json' -d '{"enabled":true}'

# 扮演浏览器：循环调 `/api/live/draw/step` 直到 done。抽成函数是因为下面
# 还要再跑一轮（验"够 2 条有效就停止抓取"），**判据只写一份**。
DRAW_JSON="$TMP/draw.json"
draw_until_done() {
  local i
  for i in $(seq 1 20); do
    curl -fsS "${W[@]}" -X POST "$B/plugins/mcloud/api/live/draw/step" -o "$DRAW_JSON"
    if python3 -c "import json,sys; sys.exit(0 if json.load(open('$DRAW_JSON'))['done'] else 1)"; then
      printf '   推完（第 %s 步）\n' "$i"
      return 0
    fi
  done
  echo "❌ 20 步还没推完" >&2; cat "$DRAW_JSON" >&2; return 1
}
draw_until_done

curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" -o "$TMP/mock.json"
python3 - "$TMP/draw.json" "$TMP/mock.json" <<'PY'
import json, sys

final = json.load(open(sys.argv[1]))
st = final['state']
assert st['step'] == 'done', st
# 1(余额) + 5(埋点) + 1(惊喜奖) + 2(口令) + 1(复活花) + 1(再读余额)
assert len(st['results']) == 2, st['results']

by_code = {r['code']: r for r in st['results']}
assert by_code['云盘AI高效复盘']['kind'] == 'succeeded', by_code
# ⚠ 这一条是**刻意分叉的判据**的端到端证据：
#   200118 是"本场已结束"，**不是**"口令无效" —— 后者（200108）才会触发重听
assert by_code['过期的口令']['kind'] == 'kouling-expired', by_code
assert '本场已结束' in by_code['过期的口令']['note'], by_code
assert '口令无效' not in by_code['过期的口令']['note'], by_code

# 进账 = ⑥ − ①（mock 里每次成功领 +10）
assert st['balanceBefore'] == 100 and st['balanceAfter'] == 110, st
assert '进账 10 朵' in st['summary'], st['summary']

# mock 侧：11 个请求、顺序固定、draw 的 body **是空的**（实拍 content-length: 0）
paths = [r['path'] for r in json.load(open(sys.argv[2])) if 'liveRoomFeedback' in r['path'] or 'visitlog' in r['path']]
seq = [p.split('?')[0] for p in paths]
assert seq == [
    '/ycloud/liveRoomFeedback/user/info',
    '/ycloud/visitlog/journaling',
    '/ycloud/visitlog/journaling',
    '/ycloud/visitlog/journaling',
    '/ycloud/visitlog/journaling',
    '/ycloud/visitlog/journaling',
    '/ycloud/liveRoomFeedback/firstParticipate/give',
    '/ycloud/liveRoomFeedback/redFlower/draw',
    '/ycloud/liveRoomFeedback/redFlower/draw',
    '/ycloud/liveRoomFeedback/redFlower/queryRevivalFlowers',
    '/ycloud/liveRoomFeedback/user/info',
], seq

draws = [r for r in json.load(open(sys.argv[2])) if '/redFlower/draw' in r['path']]
assert len(draws) == 2, draws
for d in draws:
    assert d['method'] == 'POST', d
    assert d['body'] == '', f"draw 的 body 必须是空的（实拍 content-length: 0）：{d['body']!r}"
    assert 'content-type' not in d['headers'], 'draw 不该带 content-type'
    assert 'code=' in d['path'], d['path']
# 口令是中文 ⇒ 必须百分号编码
assert '%E4%BA%91%E7%9B%98' in draws[0]['path'], draws[0]['path']
# 这一族的头：activityid 是签到族那个，UA 是小红花那个 iPad UA
assert draws[0]['headers'].get('activityid') == 'sign_in_3', draws[0]['headers']
assert '18_7' in draws[0]['headers'].get('user-agent', ''), draws[0]['headers']
# ⚠ 这一族**不带**签到族那套签名头（见 liveDraw.ts 文件头）
assert 'x-signature' not in draws[0]['headers'], draws[0]['headers']
print('   ✅ 领小红花：六步链 11 个请求、一次一个、200118 与 200108 分得清、进账按 ⑥−①')
PY

# ── 口令池（业务档）：draw 的结论**写回** + "够 2 条有效 ⇒ 停止抓取" ──────────
#
# 为什么要端到端再验一次：池是**跨任务**的判据（抓取侧看它决定"还抓不抓"、
# 领取侧看它决定"投哪几条"），而单测只能证明各自那一半。
echo "⑤.1 口令池：draw 的结论写回 + 够 2 条有效就停止抓取"
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/live" -o "$TMP/pool1.json"
python3 - "$TMP/pool1.json" <<'POOLPY1'
import json, sys

pool = (json.load(open(sys.argv[1])) or {}).get('pool') or {}
codes = {c['value']: c for c in pool.get('codes') or []}
# 领到 ⇒ 有效；本场已结束（200118）⇒ **无效**，但原因留成"已过期"
assert codes.get('云盘AI高效复盘', {}).get('state') == 'valid', codes
assert codes.get('过期的口令', {}).get('state') == 'invalid', codes
assert codes['过期的口令'].get('reason') == '口令已过期', codes
assert pool.get('validCount') == 1, pool
assert pool.get('stopScraping') is False, '才 1 条有效 ⇒ 还得继续抓'
print('   ✅ 写回：领到=有效、200118=无效（原因"已过期"）')
POOLPY1

# 再存两条能领到的口令，跑完第二轮 ⇒ 池里 3 条有效 ⇒ 按口径**停止抓取**
curl -fsS -o /dev/null "${W[@]}" -X POST -H 'content-type: application/json' \
  -d '{"codes":"池甲 池乙"}' "$B/plugins/mcloud/api/live/codes"
draw_until_done
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/live" -o "$TMP/pool2.json"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" -o "$TMP/mock.json"
python3 - "$TMP/pool2.json" "$TMP/mock.json" <<'POOLPY2'
import json, sys

pool = (json.load(open(sys.argv[1])) or {}).get('pool') or {}
assert pool.get('validCount') >= 2, pool
assert pool.get('stopScraping') is True, pool
# 停止抓取 = **抓取侧真的不发请求**（判据是 mock 侧没有新的 /xhs/profile）
hits = [r for r in json.load(open(sys.argv[2])) if r.get('path', '').startswith('/xhs/profile')]
assert len(hits) == 1, f'够 2 条有效之后就一个主页请求都不该发，实际 {len(hits)}'
print('   ✅ 口径：够 2 条有效 ⇒ 停止抓取（主页请求数仍为 1）')
POOLPY2

# ── H5 换票（原生凭据 → jwttoken）：三步 ────────────────────────────────────
#
# 这条链是**插件能不能用的前提**：之前只能靠人手从浏览器抄 jwttoken，
# 而那个票 2 小时就废（过期时所有任务一起回 90001，看起来像"账号被踢了"）。
echo "⑥ H5 换票：原生凭据 → 三步 → jwttoken"
curl -fsS -o /dev/null "${W[@]}" -X POST -H 'content-type: application/json' \
  -d '{"authorization":"Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2Vu"}' "$B/plugins/mcloud/api/h5/auth"
for i in 1 2 3 4 5; do
  curl -fsS "${W[@]}" -X POST "$B/plugins/mcloud/api/h5/step" -o "$TMP/h5.json"
  if python3 -c "import json,sys; sys.exit(0 if json.load(open('$TMP/h5.json'))['done'] else 1)"; then
    printf '   换完（第 %s 步）\n' "$i"
    break
  fi
  if [ "$i" = 5 ]; then echo "❌ 5 步还没换完" >&2; cat "$TMP/h5.json" >&2; exit 1; fi
done
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/h5" -o "$TMP/h5status.json"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" -o "$TMP/mock.json"
python3 - "$TMP/h5status.json" "$TMP/mock.json" "$TMP/h5.json" <<'H5PY'
import hashlib, json, sys

status = json.load(open(sys.argv[1]))
reqs = json.load(open(sys.argv[2]))
final = json.load(open(sys.argv[3]))

# ⚠ 过滤器必须把**第 4 步（smid 上报）**算进来 —— 漏了它，`h5` 就只有 3 条，
# 而断言会以"顺序不对"的面目出现（其实请求是发全了的）
h5 = [r for r in reqs if 'querySpecTokenV2' in r['path'] or 'api/timestamp' in r['path']
      or 'tyrzLogin' in r['path'] or 'deviceprofile' in r['path']]
# 三步的顺序是**固定的**，而且是这条链的全部意义（拆开调就是"每个接口都报未登录"）
seq = [r['path'].split('?')[0] for r in h5]
assert seq == ['/user/querySpecTokenV2', '/ycloud/api/timestamp',
               '/ycloud/auth-service/auth/tyrzLogin', '/deviceprofile/v4'], seq
spec, ts, login, smid = h5

# ① 原生族：Authorization **逐字**用（多加一次 `Basic ` 会得到 `Basic Basic …`，
#    而上游回的是「非法的token！」—— 听起来像凭据过期，会把人带去查有效期）
assert spec['method'] == 'POST', spec['method']
assert spec['headers'].get('authorization') == 'Basic bW9iaWxlOjEzODAwMDAwMDAwOnRva2Vu', spec['headers']
assert spec['headers'].get('content-type') == 'application/json;charset=UTF-8', spec['headers']
assert spec['body'] == '{"toSourceId":"001005"}', spec['body']
assert 'x-signature' not in spec['headers'], '这一族无签名'

# ② 时间戳：无鉴权，但要有 H5 那套头 + 指向那一页的 Referer
assert ts['method'] == 'GET', ts['method']
assert ts['headers'].get('activityid') == 'sign_in_3', ts['headers']
assert ts['headers'].get('appversion') == '12.6.0.0', ts['headers']
assert 'jwttoken' not in ts['headers'], '建会话这三步都还没有票'
referer = ts['headers'].get('referer', '')
assert 'portal/mobilecloud/index.html' in referer, referer
assert 'path=newsignin' in referer and 'sourceid=1002' in referer, referer
assert 'token=SSO-MOCK' in referer, referer
# ⚠ `targetSourceId` 必须带、且排在 token **之后**（参考实现漏过它，一次排查被带偏）
assert referer.index('token=') < referer.index('targetSourceId='), referer
assert referer.endswith('targetSourceId=001005'), referer

# ③ H5 族：body 的键序是**字典序**（签名能不能用取决于它，不是插入序）
assert login['method'] == 'POST', login['method']
assert login['body'] == '{"marketName":"sign_in_3","openAccount":0,"sourceId":"1002","token":"SSO-MOCK"}', login['body']
assert login['headers'].get('origin') == 'https://m.mcloud.139.com', login['headers']
assert 'jwttoken' not in login['headers'], '这一步正是**为了**拿票'

# 签名自洽：用 mock 收到的那三个值重算，必须等于收到的 x-signature
salt = 'sekaMdYYLIZfbCfm'  # 盐表第 2 个 —— H5 建会话用的就是它
expect = hashlib.md5(
    (salt + login['headers']['x-request-id'] + login['headers']['x-timestamp']
     + login['headers']['x-nonce'] + '' + salt).encode()).hexdigest()
assert login['headers']['x-signature'] == expect, (login['headers']['x-signature'], expect)
# ⚠ x-timestamp 必须**逐字等于服务端给的那个**（本地时钟偏一点就是 401）
assert login['headers']['x-timestamp'] == '1700000000000', login['headers']['x-timestamp']

# 换到的票：存住了、是新鲜的、手机号脱敏；而**凭据不回显**
assert status['jwt']['present'] is True, status
assert status['jwt']['fresh'] is True, status
assert status['jwt']['mobile'] == '138****0000', status['jwt']['mobile']
assert 'bW9iaWxl' not in json.dumps(status), '凭据不该出现在响应里'
assert status['auth']['fingerprint'] and len(status['auth']['fingerprint']) == 16, status['auth']
assert final['done'] is True, final
# ④ smid 风控上报（换 deviceId）—— **另一台主机、另一套码**
assert smid['headers'].get('user-agent', '').startswith('Mozilla/5.0 (Linux; Android 14'), smid['headers']
assert smid['headers'].get('origin') == 'https://m.mcloud.139.com', smid['headers']
smid_body = json.loads(smid['body'])
assert sorted(smid_body) == ['appId', 'compress', 'data', 'encode', 'ep', 'organization', 'os'], smid_body
assert smid_body['encode'] == 5 and smid_body['compress'] == 2, smid_body
assert smid_body['os'] == 'web' and smid_body['appId'] == 'default', smid_body
# `data` 是 **hex**（AES 那条路），`ep` 是 base64（RSA 那条路）—— 两条路别混
assert all(c in '0123456789abcdef' for c in smid_body['data']), 'data 该是 hex'
assert len(smid_body['data']) % 32 == 0, 'AES-CBC+PKCS7 ⇒ 16 字节对齐'
# ⚠ 换到的 deviceId 要落进会话（领取类接口靠它；没有它回 615 而文案说"活动太火爆"）。
# `/api/h5` 不回显凭据，所以这里断在**换票结果那句话**上，而不是断在会话原文上。
assert 'deviceId' in (status['exchange'].get('note') or ''), status['exchange']
assert status['exchange']['step'] == 'done', status['exchange']
assert status['exchange']['ok'] is True, status['exchange']
print('   ✅ H5 换票：四步顺序固定（含 smid）、签名自洽、x-timestamp 用服务端的、凭据不回显')
H5PY

# ── ⑦ 直播日程（门）：只读地取「今天开播了吗 / 下一场几点」──────────────────
#
# ⚠ 为什么放在**最后**：这一族的第一步也是 `/user/querySpecTokenV2`
#   （`toSourceId` 不同 —— 直播侧是 `017027`）。放在 ⑥ 之前的话，
#   ⑥ 那段"四步顺序固定"的断言会多出两发、以"顺序不对"的面目失败。
echo "⑦ 直播日程（门）：三步、只读、结果落池"
curl -fsS -o /dev/null "${W[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"gateBase\":\"http://127.0.0.1:$MOCK_PORT\"}" "$B/plugins/mcloud/api/config"

# 一步一发（handshake 步内部两发：SSO 只活几分钟 ⇒ ①② 不能拆开 —— 见 liveGateTask.ts）
for i in 1 2 3 4; do
  curl -fsS "${W[@]}" -X POST "$B/plugins/mcloud/api/live/gate/step" -o "$TMP/gate.json"
  if python3 -c "import json,sys; sys.exit(0 if json.load(open('$TMP/gate.json'))['done'] else 1)"; then
    printf '   探完（第 %s 步）\n' "$i"
    break
  fi
  if [ "$i" = 4 ]; then echo "❌ 4 步还没探完" >&2; cat "$TMP/gate.json" >&2; exit 1; fi
done

curl -fsS "${H[@]}" "$B/plugins/mcloud/api/live" -o "$TMP/live-gate.json"
curl -fsS "http://127.0.0.1:$MOCK_PORT/_debug/requests" -o "$TMP/mock.json"
python3 - "$TMP/live-gate.json" "$TMP/mock.json" <<'GATEPY'
import json, sys

live = json.load(open(sys.argv[1]))
reqs = json.load(open(sys.argv[2]))

# ── ① 请求形状：三步、顺序固定、鉴权头各就各位 ──
gate = [r for r in reqs if 'querySpecTokenV2' in r['path'] or 'cmpassLoginByCmToken' in r['path']
        or 'tabContentList' in r['path']]
# 前面 ⑥ 也打过一发 querySpecTokenV2（签到的 toSourceId）⇒ 按 body 挑出**门**那一发
specs = [r for r in gate if 'querySpecTokenV2' in r['path']]
mine = [r for r in specs if json.loads(r.get('body') or '{}').get('toSourceId') == '017027']
assert len(mine) == 1, f'门该换一发直播侧的 SSO（toSourceId=017027），实际 {len(mine)}'
sso_req = mine[0]
assert sso_req['method'] == 'POST', sso_req
# ⚠ 这一步要的是**原生凭据**（与签到那一步同一个端点、同一个头）
assert sso_req['headers'].get('authorization', '').startswith('Basic '), sso_req['headers']

# 门的四发（按时间顺序）：①② 一次调用、③③ 一次调用
tail = [r for r in reqs if r['path'].startswith('/api/') or 'querySpecTokenV2' in r['path']]
tail = [r for r in tail if json.loads(r.get('body') or '{}').get('toSourceId') in (None, '017027')]
seq = [r['path'].split('?')[0] for r in tail[-4:]]
assert seq == ['/user/querySpecTokenV2', '/api/user/auth/cmpassLoginByCmToken',
               '/api/channel/channel/tabContentList', '/api/channel/channel/tabContentList'], seq
assert len(tail) == 4, f'门一轮正好四发（两步 × 两发），实际 {len(tail)}：{seq}'

cmpass, tab1, tab2 = tail[-3], tail[-2], tail[-1]
# ② 用的是 ① 换回来的那个 SSO，而且这一步**还没有票**（不带 Authorization）
assert json.loads(cmpass['body']) == {'cmpassToken': 'SSO-MOCK'}, cmpass['body']
assert 'authorization' not in {k.lower() for k in cmpass['headers']}, cmpass['headers']
# ③ 两个页签都查（127 福利 + 129 回放），带**直播侧** JWT（Authorization，不是 jwttoken）
assert 'tabId=127' in tab1['path'] and 'tabId=129' in tab2['path'], (tab1['path'], tab2['path'])
for t in (tab1, tab2):
    assert t['method'] == 'GET', t
    assert t['headers'].get('authorization', '').startswith('MOCK-LIVE-JWT'), t['headers']
    assert 'jwttoken' not in {k.lower() for k in t['headers']}, '直播族用 Authorization，不是 jwttoken'

# ── ② 读数：去重、两个坑都在 ──
g = live['gate']
assert g['active'] is True, g
# 在播两间：147490「福建移动」（**不是**那个主播）+ 147606「中国移动云盘」
assert g['liveCount'] == 2, g
# 合并去重后四间（147606 在 127 与 129 里各出现一次）
ids = [r['roomId'] for r in g['rooms']]
assert ids == [147490, 147606, 147608, 147609], ids
preview = [r for r in g['rooms'] if r['status'] == 0]
assert len(preview) == 1 and preview[0]['expectStartTime'], preview

# ── ③ 落池：日程 + 门 + 场次；「下一场」就是那间预告场 ──
pool = live['pool']
# ⚠ `pool` 是**摘要**（`poolSummary`）：日程那一整张表在门的读数里（上面已断言 4 间），
#   摘要只带"什么时候探的 / 下一场是几点 / 见过几场"这几格。
assert pool.get('scheduleAtMs'), pool
assert pool['nextStart'] == preview[0]['expectStartTime'], (pool.get('nextStart'), preview)
assert len(pool['sessions']) >= 1, pool.get('sessions')

# ── ④ 凭据不回显（JWT 是凭据：它落盘是为了跨调用，但**不进任何响应**）──
assert 'MOCK-LIVE-JWT' not in json.dumps(live), '直播侧 JWT 不该出现在响应里'
print('   ✅ 直播日程：三步四发、只查 127/129、去重、日程与「下一场」落池、凭据不回显')
GATEPY

# ── ⑧ 听弹幕（WS / SockJS）—— 真连接、真帧、真口令 ────────────────────────────
#
# 这一支以前**没有 e2e**：宿主在第二十一轮之前根本没有 WebSocket，而 mock 也不会
# 讲 WS。两边都补齐之后，这里才是"弹幕真的能听"的唯一端到端证据（**只打 mock**）。
#
# ⚠ 顺序：它接在门后面 —— 因为听弹幕的第一步就是**自己走一遍门**（换票 → 看页签 → roomBeat）。
# ⚠ 它用 `wsBase` 这个**另一个口子**（`ws://`，带端口），与门的 `gateBase` 不是同一个。
echo "⑧ 听弹幕（WS/SockJS）"
curl -fsS "${W[@]}" -X POST \
  -d "{\"wsBase\":\"ws://127.0.0.1:$MOCK_PORT\",\"imBase\":\"http://127.0.0.1:$MOCK_PORT\"}" "$B/plugins/mcloud/api/config" > /dev/null
curl -fsS "${W[@]}" "$B/plugins/mcloud/api/config" -o "$TMP/config-ws.json"
python3 - "$TMP/config-ws.json" <<'CFGWS'
import json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg['wsBase'].startswith('ws://127.0.0.1:'), cfg
print('   ✅ 配置口子：wsBase 指到 mock（`ws://` 而不是 `http://`）')
# ⚠ `imBase`（进房间那一台）**必须单独指**：不指的话 `member/apply` 会打到真主机
#   `videoim.cmcc-cs.cn:20103` 上，现象是一个 **401**（看起来像"凭据不对"）。
assert cfg['imBase'].startswith('http://127.0.0.1:'), cfg
print('   ✅ 配置口子：imBase 指到 mock（进房间那一台也是另一个键）')
CFGWS

curl -fsS "${W[@]}" -X POST "$B/_debug/requests/clear" > /dev/null 2>&1 || true
# WS 那一段的请求记在 mock 自己的口子上；这里先清一遍，让"重新走门"的三发可数
curl -fsS "${W[@]}" "http://127.0.0.1:$MOCK_PORT/_debug/requests/clear" > /dev/null
# 链是 6 步（handshake/rooms/**userToken**/roomBeat/**apply**/open）⇒ 最多 8 次尝试
for i in 1 2 3 4 5 6 7 8; do
  curl -fsS "${W[@]}" -X POST "$B/plugins/mcloud/api/live/listen/step" -o "$TMP/listen-$i.json"
  if python3 -c "import json,sys; s=json.load(open('$TMP/listen-$i.json')); sys.exit(0 if s.get('step') in ('listen','done') else 1)"; then break; fi
  if [ "$i" = 8 ]; then echo "❌ 8 步还没进到 listen/打开 WS" >&2; cat "$TMP/listen-1.json" >&2; exit 1; fi
done

curl -fsS "${W[@]}" "http://127.0.0.1:$MOCK_PORT/_debug/ws" -o "$TMP/ws.json"
python3 - "$TMP/ws.json" <<'WSPY'
import json, sys
ws = json.load(open(sys.argv[1]))
assert ws['connected'], 'WS 该连上了'
assert ws['provisioned'], '该收到 PROVISION 了'
# 升级请求的形状（抓包 §一 那三条判据里的两条：UA 与 Origin；签名头**不该有**）
h = ws['upgradeHeaders']
assert 'cmcc-cs.cn' in json.dumps(h.get('origin', '')), h.get('origin')
ua = h.get('user-agent', '')
assert 'MCloudApp' in ua, ua
assert 'systemmd5' not in h and 'tokenmd5' not in h, 'WS 升级请求不该带签名头（抓包 §一 判据 1）'
cmds = [f['command'] for f in ws['frames']]
assert cmds[:1] == [3], cmds          # 第一帧就是 PROVISION
assert 3 in cmds, cmds
print(f"   ✅ WS：连上、PROVISION 已发（客户端帧命令 {cmds[:4]}…）、升级头形状照抓包")
WSPY

# 推一条弹幕（`command=2`，文本在 MSync.9→.2→.6→.4→.2）—— 插件该解出文本、回 ack、把口令落池
curl -fsS "${W[@]}" -X POST -d '{"text":"小红花口令：一键9图出圈"}' \
  "http://127.0.0.1:$MOCK_PORT/_debug/ws/danmaku" -o "$TMP/pushed.json"
curl -fsS "${W[@]}" -X POST "$B/plugins/mcloud/api/live/listen/step" -o "$TMP/listen-after.json"
curl -fsS "${W[@]}" "http://127.0.0.1:$MOCK_PORT/_debug/ws" -o "$TMP/ws2.json"
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/live" -o "$TMP/live-listen.json"
python3 - "$TMP/ws2.json" "$TMP/live-listen.json" <<'DANPY'
import json, sys
ws = json.load(open(sys.argv[1]))
live = json.load(open(sys.argv[2]))
cmds = [f['command'] for f in ws['frames']]
assert 0 in cmds, f'收到弹幕该回 ack（command=0）；实际 {cmds}'
assert ws['acked'] >= 1, ws
lis = live['listen']['reading']
assert lis['danmakuFrames'] >= 1, lis
assert '一键9图出圈' in lis['codes'], lis
code = [c for c in live['pool']['codes'] if c['value'] == '一键9图出圈']
assert code and code[0]['source'] == 'danmaku', code
print('   ✅ 弹幕：文本解出来、回了 ack、口令落池（来源 danmaku）')

DANPY

# ── ⑨ 直播自动定时（mcloud 的 `live_auto`）：时刻 = 「下一场」+ 1 小时 ──────────
# ⚠ 这条判据只靠读数就能核：`live-auto` 每 5 分钟算一次、**零上游请求**，
#   而它算出来的时刻必须等于"池里那间预告场的开播时间 + 1 小时"。
curl -fsS "${W[@]}" -X POST "$B/api/tasks/mcloud/live-auto/run" -o /dev/null
curl -fsS "${W[@]}" "$B/plugins/mcloud/api/live" -o "$TMP/live-auto.json"
python3 - "$TMP/live-auto.json" <<'AUTOPY'
import json, sys
live = json.load(open(sys.argv[1]))
auto = live['auto']
pool = live['pool']
assert auto['nextStart'] == pool['nextStart'], (auto, pool)
assert auto['nextStart'] != '', 'mock 里有一间预告场，这里该有「下一场」'
assert auto['wakeAt'] != '', ('没算出来', auto)
# 时刻 = 下一场 + 1 小时（**按墙钟字符串**比：定长 ⇒ 字典序 = 时间序；
# 东八区在这里又加回 8 小时，所以直接按字符串解析成 epoch 比毫秒）
from datetime import datetime, timedelta
start = datetime.strptime(auto['nextStart'], '%Y-%m-%d %H:%M:%S')
want = (start + timedelta(hours=1)).strftime('%Y-%m-%d %H:%M:%S')
assert auto['wakeAt'] == want, (auto['wakeAt'], want)
assert auto['expr'].endswith(' *'), auto['expr']
print(f"   ✅ 自动定时：下一场 {auto['nextStart']} ⇒ {auto['wakeAt']} 醒（等价 cron {auto['expr']}）")
AUTOPY

# ── ⑩ 「听到就领」的节拍：`live-draw` 必须比"每 5 分钟"快 ─────────────────────
# ⚠ 这条链是"听到 → 进池 → 领"的**衔接器**。5 分钟那一版意味着听到之后最多 5 分钟才动手，
#   而口令是当场有效的东西（mcloud 的 `live-room` 就是听到即领）。
#   便宜的理由：它没事时**一个请求都不发**就返回 idle —— 所以变快不花钱。
curl -fsS "${H[@]}" "$B/api/state" -o "$TMP/state2.json"
python3 - "$TMP/state2.json" <<'CADPY'
import json, sys
s = json.load(open(sys.argv[1]))
jobs = {j['name']: j for j in s.get('jobs', []) if j.get('plugin') == 'mcloud'}
d = jobs.get('live-draw')
assert d is not None, '没有 live-draw 这条任务'
expr = d.get('expr') or d.get('schedule') or ''
assert expr == '@every 30s', f'live-draw 的调度是 {expr!r}，应当是 @every 30s（听到就领的衔接节拍）'
assert jobs.get('live-listen') is not None and jobs.get('live-auto') is not None, jobs.keys()
print('   ✅ 衔接节拍：live-draw 是 @every 30s（听到→进池→领，不用等人点）')
CADPY
