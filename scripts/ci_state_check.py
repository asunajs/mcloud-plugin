#!/usr/bin/env python3
"""CI 里对 `/api/state` 的断言 —— **单独一个脚本**，不写在 workflow 的 heredoc 里。

为什么：

1. workflow 的 `run: |` 里嵌 heredoc 是**最容易错**的写法 —— 结束符前的缩进在
   YAML 里合法、在 bash 里就不认（`PY` 必须顶格），一改就静默坏掉。这里改成
   「一个命令 + 一个参数」，workflow 里只剩下调用。
2. 这些断言**本机也能跑**（对着正在跑的面板存一份 state.json 就行），
   不用等 CI 红了才发现写错。

用法：

    python3 scripts/ci_state_check.py ready    state.json   # 就位了没有（轮询用，超时不算它的事）
    python3 scripts/ci_state_check.py loaded   state.json   # 插件/任务/无错，逐条断言
    python3 scripts/ci_state_check.py selftest selftest.json

`ready` 只回 0/1 不说话（轮询里一句话一句会刷屏）；另外两个失败时把现场打出来。
"""

import json
import sys

PLUGINS = ("mcloud", "mcloud-daily", "mcloud-exchange", "mcloud-live")
# 三条定时任务各自的归属 —— 名字和归属都是**现在的事实**；
# 数量**不写死**（插件以后加任务不该让这条断言失效）。
JOBS = {"日常": "mcloud-daily", "兑换": "mcloud-exchange", "直播": "mcloud-live"}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def ready(state):
    names = {p["name"] for p in state.get("plugins", [])}
    jobs = {j["name"] for j in state.get("jobs", []) if not j.get("deleted")}
    return set(PLUGINS) <= names and set(JOBS) <= jobs


def cmd_ready(path):
    try:
        ok = ready(load(path))
    except (OSError, ValueError):
        ok = False
    return 0 if ok else 1


def cmd_loaded(path):
    state = load(path)
    plugins = {p["name"]: p for p in state.get("plugins", [])}
    problems = []

    # ① 四个插件都在、都是 js、都没报错、没被停用
    for name in PLUGINS:
        p = plugins.get(name)
        if not p:
            problems.append(f"没有加载 {name}（只有 {sorted(plugins)}）")
            continue
        if p.get("runtime") != "js":
            problems.append(f"{name} 的 runtime 是 {p.get('runtime')}，应该是 js")
        if p.get("error") not in (None, ""):
            problems.append(f"{name} 加载报错：{p.get('error')}")
        if p.get("disabled"):
            problems.append(f"{name} 被停用了")

    # ② 三条任务挂在对的插件上，而且有表达式
    jobs = {j["name"]: j for j in state.get("jobs", []) if not j.get("deleted")}
    for task, owner in JOBS.items():
        j = jobs.get(task)
        if not j:
            problems.append(f"没有任务「{task}」（实际 {sorted(jobs)}）")
            continue
        if j.get("plugin") != owner:
            problems.append(f"任务「{task}」挂在 {j.get('plugin')} 上，应该是 {owner}")
        if not j.get("schedule"):
            problems.append(f"任务「{task}」没有调度表达式")
        if j.get("last_error") not in (None, ""):
            problems.append(f"任务「{task}」上次报错：{j.get('last_error')}")

    # ③ `selftest` / `diag` 是**路由**，不该再出现在任务列表里。
    #    这条是防回归的：它们曾经是两条 cron 任务，改掉之后 CI 还在等它们，
    #    而那段只在 tag 上跑 ⇒ 一直红着没人看见（第一次打 tag 才发现）。
    for gone in ("selftest", "diag"):
        if gone in jobs:
            problems.append(f"任务列表里不该再有「{gone}」（它已经改成路由了）")

    if problems:
        print("❌ 插件/任务状态不对：")
        for x in problems:
            print(f"   · {x}")
        return 1
    print("✅ 4 个插件已加载、3 条任务已登记（自检已改成路由，不在任务列表里）")
    return 0


def cmd_selftest(path):
    r = load(path)
    bad = [c["name"] for c in r.get("checks", []) if not c["ok"]]
    if r.get("ok") is not True:
        print(f"❌ 沙箱自检没过：{bad} / {r.get('detail')}")
        for c in r.get("checks", []):
            if not c["ok"]:
                print(f"   · {c['name']}")
        return 1
    print(f"✅ 沙箱内自检通过：{r.get('detail')}")
    return 0


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    cmd, path = argv[1], argv[2]
    table = {"ready": cmd_ready, "loaded": cmd_loaded, "selftest": cmd_selftest}
    if cmd not in table:
        print(f"不认识的子命令：{cmd}")
        return 2
    return table[cmd](path)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
