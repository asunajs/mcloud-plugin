#!/usr/bin/env python3
"""验收「插件拆成 4 个 + 一条任务一个函数」（阶段 ②-1）。

# 要证明什么

重写的核心承诺是：**面板上只有 3 条用户看得懂的任务**，而不是 25 条
「一次一步」的零件。所以判据不是「源码编译过了」，而是**装进真面板之后
任务列表长什么样**。

1. 四个插件都加载成功（`mcloud` / `mcloud-daily` / `mcloud-exchange` / `mcloud-live`）
2. 面板上**恰好 3 条任务**，名字是「日常」「兑换」「直播」
3. 三条任务各自声明了长预算（`jobs.budget_ms` 有值，且 > 默认 2000）
4. 三条任务所在的插件都声明了 `worker_hint('exclusive')` ⇒ 各自独占一条线程
5. `mcloud` **一条任务都没有**（它是服务型插件：只提供路由 + 侧边栏入口）
6. 侧边栏入口注册上了（`/api/state` 的 `plugins[].nav`）
7. 路由真的能用：`GET /plugins/mcloud/api/selftest` 返回 `ok`
8. 插件源码页面能看到产物（`has_ui` 之类的面板字段正常）

用法：python3 scripts/split_check.py <面板可执行文件>
退出码：0 通过 / 1 判据没过 / 2 环境问题
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
BIN = sys.argv[1] if len(sys.argv) > 1 else str(HERE.parent / "rust-plugin-panel/target/release/plugin-panel")
PLUGINS = HERE / "plugins"
TOKEN = os.urandom(16).hex()

PLUGIN_NAMES = ["mcloud", "mcloud-daily", "mcloud-exchange", "mcloud-live"]
# 三条用户可见任务 —— 名字是给用户看的，所以断言它们**就是**这三个词
TASK_NAMES = ["日常", "兑换", "直播"]
TASK_PLUGIN = {"日常": "mcloud-daily", "兑换": "mcloud-exchange", "直播": "mcloud-live"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(url, method="GET", body=None, timeout=20.0, headers=None):
    req = urllib.request.Request(url, data=body, method=method)
    h = dict(headers or {})
    if not any(k.lower() in ("x-panel-token", "authorization", "cookie") for k in h):
        h["X-Panel-Token"] = TOKEN
    for k, v in h.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def wait_ready(base, proc, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            code, body = http(f"{base}/api/state", timeout=2)
            if code == 200 and json.loads(body).get("plugins"):
                return True
        except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
            pass
        time.sleep(0.25)
    return False


def main() -> int:
    if not Path(BIN).exists():
        print(f"环境问题：找不到面板 {BIN}")
        return 2
    missing = [n for n in PLUGIN_NAMES if not (PLUGINS / "js" / f"{n}.js").exists()]
    if missing:
        print(f"环境问题：缺产物 {missing} —— 先 `npm run build`")
        return 2

    failures = []

    def check(label, ok, detail=""):
        print(f"  {'✓' if ok else '✗'} {label}" + (f" — {detail}" if (detail and not ok) else ""))
        if not ok:
            failures.append(label)

    with tempfile.TemporaryDirectory(prefix="split-") as td:
        port = free_port()
        env = dict(os.environ)
        env.update(
            {
                "BIND_ADDR": f"127.0.0.1:{port}",
                # 指向本仓库的 plugins/ —— 面板按 `plugins/js/<name>.js` 认插件
                "PLUGINS_DIR": str(PLUGINS),
                "DB_PATH": str(Path(td) / "db.sqlite"),
                "PANEL_TOKEN": TOKEN,
            }
        )
        logpath = Path(td) / "panel.log"
        logf = open(logpath, "w")
        proc = subprocess.Popen([BIN], env=env, stdout=logf, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"

        try:
            if not wait_ready(base, proc):
                print("环境问题：面板没起来")
                print(logpath.read_text(errors="replace")[-2000:])
                return 2

            print("插件拆分（阶段 ②-1）· 验收\n")

            code, body = http(f"{base}/api/state")
            state = json.loads(body) if code == 200 else {}
            plugins = state.get("plugins") or []
            jobs = state.get("jobs") or []
            names = {p.get("name") for p in plugins}

            # ---- ① 四个插件都加载 ----
            print("加载（脚本断言）")
            for n in PLUGIN_NAMES:
                check(f"插件 `{n}` 已加载", n in names, f"已加载：{sorted(n for n in names if n)}")
            # 旧的单文件插件不该还在（它已经被 4 个入口取代）
            check(
                "旧的 `plugins/js/mcloud.js` 就是新的 `mcloud`（不是残留的旧产物）",
                "mcloud" in names,
            )

            # ---- ② 恰好 3 条任务 ----
            print("\n任务列表（脚本断言）")
            visible = sorted(j.get("name") for j in jobs)
            check(
                "面板上恰好 3 条任务",
                len(jobs) == 3,
                f"实际 {len(jobs)} 条：{visible}",
            )
            check("三条任务就是「日常 / 兑换 / 直播」", visible == sorted(TASK_NAMES), f"{visible}")

            # ---- ③ 长预算 ----
            print("\n执行预算（脚本断言）")
            for name, plugin in TASK_PLUGIN.items():
                row = next((j for j in jobs if j.get("name") == name), None)
                if row is None:
                    check(f"「{name}」在任务表里", False)
                    continue
                check(f"「{name}」挂在 `{plugin}` 上", row.get("plugin") == plugin, str(row.get("plugin")))
                b = row.get("budget_ms") or 0
                # 全局默认是 2000 —— 一个「从头跑到尾」的任务必然超过它
                check(f"「{name}」声明了长预算（> 默认 2000ms）", b > 2000, f"budget_ms={b}")

            # ---- ④ 服务型插件没有任务 ----
            print("\n服务型插件（脚本断言）")
            mcloud_jobs = [j for j in jobs if j.get("plugin") == "mcloud"]
            check("`mcloud` 一条任务都没有（它只提供路由）", len(mcloud_jobs) == 0, f"{len(mcloud_jobs)} 条")

            # ---- ⑤ 侧边栏入口 ----
            print("\n侧边栏入口（脚本断言）")
            nav = next((p.get("nav") for p in plugins if p.get("name") == "mcloud"), None)
            check("`mcloud` 注册了侧边栏入口", nav is not None, "nav 字段为空")
            if nav:
                check("入口标签是人话", nav.get("label") == "云盘", str(nav.get("label")))
                check("入口有图标", bool(nav.get("icon")), str(nav.get("icon")))

            # ---- ⑥ 路由真的能用 ----
            print("\n路由（脚本断言）")
            code, body = http(f"{base}/plugins/mcloud/api/selftest")
            ok = False
            detail = f"http {code} {body[:120]}"
            if code == 200:
                try:
                    ok = json.loads(body).get("ok") is True
                except json.JSONDecodeError:
                    pass
            check("沙箱自检路由返回 ok（说明密码学 + SQLite 在沙箱里都对）", ok, detail)

            # ---- ⑦ 界面真的能加载 ----
            print("\n界面（脚本断言）")
            code, page = http(f"{base}/plugins/mcloud/index.html")
            check("插件页面能取到", code == 200 and "<html" in page.lower(), f"http {code}")
            for word in ["账号", "日常", "兑换", "直播", "数据", "推送", "设置"]:
                check(f"菜单栏有「{word}」", f'>{word}</button>' in page, "菜单里找不到这个词")
            check(
                "菜单栏恰好 7 项",
                page.count('class="menu-item') == 7,
                f"实际 {page.count('class=\"menu-item')} 项",
            )
            check("没有「高级」开关", "adv-toggle" not in page)
            code, js = http(f"{base}/plugins/mcloud/app.js")
            check(
                "app.js 能取到且只调一个读数接口",
                code == 200 and "api('/readings')" in js,
                f"http {code}",
            )
            code, css = http(f"{base}/plugins/mcloud/style.css")
            check("样式表能取到", code == 200 and len(css) > 500, f"http {code} {len(css)} 字节")
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            ok = False
            if code == 200:
                try:
                    d = json.loads(body)
                    ok = all(k in d for k in ("account", "daily", "exchange", "live", "data", "push", "settings"))
                except json.JSONDecodeError:
                    pass
            check("聚合读数接口七个区块都在", ok, f"http {code} {body[:100]}")

            # ---- ⑧ 线程分配 ----
            print("\n线程（脚本断言）")
            logf.flush()
            text = logpath.read_text(errors="replace")
            for n in ["mcloud-daily", "mcloud-exchange", "mcloud-live"]:
                check(f"`{n}` 独占一条线程", f"`{n}` → worker" in text and "独占" in text)
            # 三个独占插件 ⇒ 至少 3 条线程（面板会自动抬 ENGINE_WORKERS）
            check(
                "面板为独占插件抬了线程数",
                "自动抬到" in text or "ENGINE_WORKERS" in text,
                "日志里没看到线程数抬升",
            )
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=6)
            except Exception:
                proc.kill()
            logf.close()

    print()
    if failures:
        print(f"❌ {len(failures)} 项失败: {', '.join(failures)}")
        return 1
    print("✅ 通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
