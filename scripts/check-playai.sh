#!/usr/bin/env bash
# 跑完之后「趣玩AI 到底成了没」—— 一条命令给出结论，不用翻界面。
#
# 为什么单独一个脚本：那一族有三种结局（做完了 / 已上报但服务端没认 / 动作链断在某一段），
# 而它们混在几十行日常日志里。判断要连着看：日志里的那几句 + 状态里的最后一份读数。
#
# 用法：
#   ./scripts/check-playai.sh                       # 默认看 ~/panel-3030（本机实例，示例路径）
#   ./scripts/check-playai.sh --data-dir /path/to/data --hours 24
#
# ⚠ 只**读**：查面板的 logs 表 + 插件的 state 文件，不发任何请求、不碰账号。
set -uo pipefail

DATA_DIR="${HOME}/panel-3030/data"
HOURS=24
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) DATA_DIR="${2:?--data-dir 要一个目录}"; shift 2 ;;
    --hours)    HOURS="${2:?--hours 要一个数字}"; shift 2 ;;
    -h|--help)  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done

DB="$DATA_DIR/panel.db"
[ -f "$DB" ] || { echo "❌ 找不到 $DB（用 --data-dir 指面板的数据目录）" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "❌ 需要 sqlite3" >&2; exit 1; }

echo "=== 最近 ${HOURS} 小时里 mcloud-daily 提到「趣玩AI」的行 ==="
sqlite3 -separator ' | ' "$DB" \
  "select time(ts/1000,'unixepoch','+8 hours') || '  ' || level || '  ' || replace(message, char(10), ' ')
     from logs
    where plugin = 'mcloud-daily'
      and message like '%趣玩AI%'
      and ts > strftime('%s','now','-' || ${HOURS} || ' hours') * 1000
    order by ts desc limit 20;" || true

echo
echo "=== 最后一份读数（插件状态文件里的 mcloud.playai.reading）==="
python3 - "$DATA_DIR" <<'PY'
import glob, json, os, sys
root = os.path.join(sys.argv[1], 'plugin-data', 'mcloud', 'state')
rows = []
for f in glob.glob(os.path.join(root, '*.json')):
    try:
        d = json.load(open(f, encoding='utf-8'))
    except Exception:
        continue
    raw = d.get('mcloud.playai.reading')
    if not raw:
        continue
    try:
        snap = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        continue
    rows.append((os.path.basename(f)[:-5], snap))
if not rows:
    print('（没有——这一族还没跑过，或者这个号没被选中）')
for acct, s in rows:
    print(f"  {acct}: ok={s.get('ok')}  at={s.get('at')}")
    print(f"    {s.get('line') or '（空）'}")
    if s.get('error'):
        print(f"    error: {s['error']}")
PY

echo
echo "=== 结论怎么读 ==="
cat <<'TXT'
  日志里有「做完了（回读已翻位）」        ⇒ 成了：服务端认这一句，可以接抽奖/别的工具
  日志里有「已上报，服务端还没认」        ⇒ 点了也聊了，但 isComplete 两次回读都没翻
                                          ⇒ **灵犀对话不算那件任务**，要换动作（先抓一轮包）
  日志里有「做「…」那一步没成：…」        ⇒ 动作链断在某一段，看冒号后面那段
  日志里有「活动已结束」/「活动已下线」    ⇒ 活动窗口过了，这一族已停（正常）
  只有「还没有网页会话」                  ⇒ 票没换成，先解决登录（跟这一族无关）
  什么都没有                              ⇒ 这一族没跑到：看它是否被关、或没被选中
TXT
