#!/usr/bin/env python3
"""CI 里对 /api/state 的断言 —— **单独一个脚本**，不写在 workflow 的 heredoc 里。

为什么单独一个：
1. workflow 的 `run: |` 里嵌 heredoc 是最容易错的写法（结束符必须顶格）；
2. 这些断言**本机也能跑**（对着正在跑的面板存一份 state.json 就行），不用等 CI 红了才发现写错。

用法：

    python3 scripts/ci_state_check.py ready    state.json   # 就位了没有（轮询用，超时不算它的事）
    python3 scripts/ci_state_check.py loaded   state.json   # 插件/任务/无错，逐条断言
    python3 scripts/ci_state_check.py selftest selftest.json

⚠ 面板换到 panel-llrt 之后形状变了：任务在 `tasks`（不是 `jobs`），表达式叫 `cron`
  （不是 `schedule`）。这里两种都认 —— 插件仓的 CI 不该因为"面板换了个字段名"整片红。
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


def tasks_of(state):
    """任务表：新面板叫 tasks，老面板叫 jobs。"""
    rows = state.get("tasks")
    if not isinstance(rows, list):
        rows = state.get("jobs", [])
    return {t.get("name"): t for t in rows if not t.get("deleted")}


def ready(state):
    names = {p.get("name") for p in state.get("plugins", [])}
    jobs = tasks_of(state)
    return set(PLUGINS) <= names and set(JOBS) <= set(jobs)


def cmd_ready(path):
    try:
        ok = ready(load(path))
    except (OSError, ValueError):
        ok = False
    return 0 if ok else 1


def cmd_loaded(path):
    state = load(path)
    plugins = {p.get("name"): p for p in state.get("plugins", [])}
    problems = []

    # ① 四个插件都在、都没报错、没被停用/暂停
    for name in PLUGINS:
        p = plugins.get(name)
        if not p:
            problems.append(f"没有加载 {name}（只有 {sorted(plugins)}）")
            continue
        if p.get("error") not in (None, ""):
            problems.append(f"{name} 加载报错：{p.get('error')}")
        if p.get("disabled"):
            problems.append(f"{name} 被停用了")
        if p.get("suspended"):
            problems.append(f"{name} 被暂停了")

    # ② 三条任务挂在对的插件上，而且有表达式
    jobs = tasks_of(state)
    for task, owner in JOBS.items():
        j = jobs.get(task)
        if not j:
            problems.append(f"没有任务「{task}」（实际 {sorted(jobs)}）")
            continue
        if j.get("plugin") != owner:
            problems.append(f"任务「{task}」挂在 {j.get('plugin')} 上，应该是 {owner}")
        if not (j.get("cron") or j.get("schedule")):
            problems.append(f"任务「{task}」没有调度表达式")
        if j.get("pending_adopt"):
            problems.append(f"任务「{task}」还停在「待采纳」—— 安装时要采纳计划建议")
        if j.get("last_error") not in (None, ""):
            problems.append(f"任务「{task}」上次报错：{j.get('last_error')}")

    # ③ `selftest` / `diag` 是**路由**，不该再出现在任务列表里（防回归）
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
    checks = r.get("checks") or []
    bad = [c.get("name") for c in checks if not c.get("ok")]
    if r.get("ok") is not True:
        print(f"❌ 沙箱自检没过：{bad} / {r.get('detail')}")
        for name in bad:
            print(f"   · {name}")
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
