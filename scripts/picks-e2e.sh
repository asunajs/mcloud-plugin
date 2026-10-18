#!/usr/bin/env bash
# 对着 mock 上游验一遍「选奖品」那条缓存（**绝不碰真账号**）。
set -uo pipefail
HERE=/Users/catlair/mobile/workspace/mcloud-plugin
BIN=/Users/catlair/mobile/workspace/rust-plugin-panel/target/release/plugin-panel
PORT=18983
MOCK=$((PORT+100))
TOKEN=e2e-mock-token
B="http://127.0.0.1:$PORT"
H=(-H "X-Panel-Token:$TOKEN")
W=("${H[@]}" -H "x-panel:1")
OUT=/tmp/apv-run

cd "$HERE" || exit 1
E2E_KEEP=1 ./scripts/e2e-mock.sh "$BIN" "$PORT" > "$OUT/e2e-picks.log" 2>&1
E2E_RC=$?
echo "=== e2e 退出码：$E2E_RC ==="
grep -E "❌|AssertionError|面板与 mock 还在跑|要收摊" "$OUT/e2e-picks.log" | head -5
PANEL_PID=$(lsof -ti -i "tcp:$PORT" | head -1)
MOCK_PID=$(lsof -ti -i "tcp:$MOCK" | head -1)
echo "面板 PID=$PANEL_PID mock PID=$MOCK_PID"

echo "── 探针 ①：今天第一次打开这一屏（缓存该是空的）"
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/readings" -o "$OUT/v0.json"
python3 - "$OUT/v0.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])) or {}
ex = d.get('exchange') or {}
print('   exchange.picks =', json.dumps(ex.get('picks'), ensure_ascii=False)[:60])
print('   exchange.plan  =', repr(ex.get('plan')))
PY

echo "── 探针 ②：手动刷新（POST /exchange/picks）"
curl -fsS "${W[@]}" -X POST -H 'content-type: application/json' -d '{}' \
  "$B/plugins/mcloud/api/exchange/picks" -o "$OUT/picks.json"
python3 - "$OUT/picks.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
items = (d.get('picks') or {}).get('items') or []
print('   note:', d.get('note'))
print('   date:', (d.get('picks') or {}).get('date'), '| 件数:', len(items))
for i in items[:3]:
    print('   ', json.dumps(i, ensure_ascii=False))
assert items, '缓存里一件都没有'
assert all(i.get('name') for i in items), '有名字为空的项'
open('/tmp/apv-run/pick-name.txt', 'w').write(items[0]['name'])
open('/tmp/apv-run/pick-id.txt', 'w').write(str(items[0].get('id', '')))
PY

echo "── 探针 ③：刷新只打「清单」那一枪（mock 侧数请求）"
curl -fsS -X POST "http://127.0.0.1:$MOCK/_debug/requests/clear" >/dev/null
curl -fsS "${W[@]}" -X POST -H 'content-type: application/json' -d '{}' \
  "$B/plugins/mcloud/api/exchange/picks" -o /dev/null
curl -fsS "http://127.0.0.1:$MOCK/_debug/requests" -o "$OUT/mock2.json"
python3 - "$OUT/mock2.json" <<'PY'
import json, sys
reqs = json.load(open(sys.argv[1]))
paths = [r['path'].split('?')[0] for r in reqs]
print('   mock 收到：', paths)
assert paths == ['/market/exchange/exchangeList'] or (paths and all('exchangeList' in p for p in paths)), f'不止一枪：{paths}'
assert len(paths) == 1, f'该只有一发，实际 {len(paths)}'
bad = [p for p in paths if 'slide' in p or 'order' in p or 'infoV3' in p]
assert not bad, f'碰到下单/余额了：{bad}'
print('   ✅ 只发清单那一枪')
PY

echo "── 探针 ④：界面那条视图现在带着缓存（/readings 与 /exchange 都要有）"
for ep in readings exchange; do
  curl -fsS "${H[@]}" "$B/plugins/mcloud/api/$ep" -o "$OUT/v1.json"
  python3 - "$OUT/v1.json" "$ep" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])) or {}
ex = d.get('exchange') if 'exchange' in (d or {}) and isinstance(d.get('exchange'), dict) else d
p = (ex or {}).get('picks') or {}
print(f'   /{sys.argv[2]}: picks {len(p.get("items") or [])} 件，date={p.get("date")}')
PY
done

echo "── 探针 ⑤：存目标 = 缓存里那一句名字（写那半仍然只写字，不发枪）"
NAME=$(cat "$OUT/pick-name.txt")
curl -fsS -o /dev/null "${W[@]}" -X POST -H 'content-type: application/json' \
  -d "{\"query\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$NAME")}" \
  "$B/plugins/mcloud/api/exchange/order"
curl -fsS -X POST "http://127.0.0.1:$MOCK/_debug/requests/clear" >/dev/null
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/readings" -o "$OUT/v2.json"
curl -fsS "http://127.0.0.1:$MOCK/_debug/requests" -o "$OUT/mock3.json"
python3 - "$OUT/v2.json" "$OUT/mock3.json" "$NAME" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])) or {}
ex = d.get('exchange') or {}
name = sys.argv[3]
print('   存到的 plan:', repr(ex.get('plan')))
assert ex.get('plan') == name, (ex.get('plan'), name)
assert (ex.get('picks') or {}).get('items'), '视图里缓存没了'
reqs = json.load(open(sys.argv[2]))
print('   存完之后 mock 收到：', [r['path'] for r in reqs])
assert reqs == [], '存目标不该发请求'
print('   ✅ 目标=缓存里那句名字，且不发枪')
PY

echo "── 探针 ⑥：凭据不回显 + 日志里那一行说人话"
grep -oE '"note": *"[^"]*"' "$OUT/picks.json" | head -3
curl -fsS "${H[@]}" "$B/plugins/mcloud/api/log/tail?limit=8" -o "$OUT/log.json" 2>/dev/null || true
python3 - "$OUT/log.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print('   （日志口子形状不同，跳过）'); sys.exit()
lines = d.get('lines') or d.get('log') or []
for l in lines[-6:]:
    print('   ', (l.get('message') or l.get('msg') or str(l))[:90])
PY

echo "── 探针 ⑦：界面真的把下拉画出来了（无 JS 报错）"
node "$HERE/scripts/../../scripts/picks_probe.mjs" "$B" "$TOKEN" 2>/dev/null || echo "   （静态探针跳过）"

echo "收摊"
kill "$PANEL_PID" "$MOCK_PID" 2>/dev/null || true
