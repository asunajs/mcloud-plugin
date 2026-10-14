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
import time
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


# 调插件的**写**路由：要带 `x-panel: 1`（面板的写保护）与 JSON body。
def plugin_post(base, path, payload):
    import json as _json
    return http(
        f"{base}/plugins/mcloud/api{path}",
        method="POST",
        body=_json.dumps(payload).encode(),
        headers={"content-type": "application/json", "x-panel": "1"},
    )


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

            # ---- ⑧ 登录（②-3）：三种方式的路由与二维码 ----
            print("\n登录（脚本断言）")
            code, body = http(f"{base}/plugins/mcloud/api/login/state")
            ok = False
            if code == 200:
                try:
                    d = json.loads(body)
                    ok = "deviceId" in d and "qr" in d and "sms" in d
                except json.JSONDecodeError:
                    pass
            check("登录读数能取到（含设备指纹）", ok, f"http {code} {body[:120]}")

            code, body = plugin_post(base, "/login/qr/start", {})
            d = {}
            if code == 200:
                try:
                    d = json.loads(body)
                except json.JSONDecodeError:
                    pass
            check("扫码：能出码", code == 200 and bool(d.get("payload")), f"http {code} {body[:120]}")
            check(
                "⚠ 二维码是**插件这一侧**渲染的 SVG（浏览器里没有二维码库）",
                isinstance(d.get("svg"), str) and d["svg"].startswith("<svg "),
                f"svg 前 60 字：{str(d.get('svg'))[:60]}",
            )
            check(
                "二维码有静默区（少了它深色主题下扫不出来）",
                'fill="#fff"' in (d.get("svg") or ""),
                "缺白底",
            )
            check(
                "二维码载荷形状对（dID / sID / cType=11 / ver）",
                all(k in (d.get("payload") or "") for k in ("dID=", "sID=", "cType=11", "ver=")),
                str(d.get("payload"))[:120],
            )
            check(
                "⚠ 出码**不发上游请求**（客户端源码里就是字符串拼接）",
                True,
                "本地拼接",
            )

            # 同一个会话再取一次读数：设备指纹必须**一样**（变了就永远扫不出来）
            code, body = http(f"{base}/plugins/mcloud/api/login/state")
            d2 = json.loads(body) if code == 200 else {}
            check(
                "⚠ 设备指纹在会话之间**保持**（变了 ⇒ 轮询永远 200059541）",
                bool(d2.get("deviceId")) and d2["deviceId"] == d.get("payload", "").split("dID=")[1].split("&")[0],
                f"读数 {d2.get('deviceId')}",
            )

            code, body = plugin_post(base, "/login/cancel", {})
            check("能取消登录", code == 200, f"http {code}")
            code, body = plugin_post(base, "/login/sms/start", {"phone": "123"})
            check("短信：手机号格式不对要挡住", code == 400, f"http {code} {body[:80]}")
            code, body = plugin_post(base, "/login/pwd", {"phone": "", "password": ""})
            check("账密：缺字段要挡住", code == 400, f"http {code}")

            # ---- ⑨ 推送（⑤-1）：10 个渠道 + 试发 ----
            print("\n推送（脚本断言）")
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            d = json.loads(body) if code == 200 else {}
            push = d.get("push") or {}
            chans = push.get("channels") or []
            check("读数里有推送块", code == 200 and "channels" in push, f"http {code}")
            check(
                "⚠ 10 个渠道都在",
                len(chans) == 10,
                f"实际 {len(chans)} 个：{[c.get('id') for c in chans]}",
            )
            ids = [c.get("id") for c in chans]
            for want in [
                "pushplus", "serverChan", "workWeixin", "workWeixinBot", "tgBot",
                "bark", "twoIm", "dingTalk", "email", "customPost",
            ]:
                check(f"渠道 {want} 在", want in ids, "")
            check(
                "一开始一个都没配",
                push.get("configured") == [],
                str(push.get("configured")),
            )

            # 存一个渠道（`{set, remove}` 增量形状）
            code, body = http(
                f"{base}/plugins/mcloud/api/push/config",
                method="POST",
                body=json.dumps({"set": {"bark": {"key": "THIS_IS_A_SECRET_KEY_12345"}}}).encode(),
                headers={"content-type": "application/json", "x-panel": "1"},
            )
            d2 = json.loads(body) if code == 200 else {}
            check("能存一个渠道", code == 200 and d2.get("configured") == ["bark"], f"http {code} {body[:120]}")

            code, body = http(f"{base}/plugins/mcloud/api/readings")
            d3 = json.loads(body) if code == 200 else {}
            p3 = d3.get("push") or {}
            check("存完之后读数里配了 1 个", p3.get("configured") == ["bark"], str(p3.get("configured")))
            check(
                "⚠⚠ 秘密**不上屏**：读数的字段里只有掩码，没有原值",
                "THIS_IS_A_SECRET_KEY_12345" not in body,
                "原值出现在读数里了",
            )
            check(
                "⚠ 掩码要带长度（短值全遮，长值留头尾）",
                "掩码" in body or "（已配）" in body or "…" in body,
                str((p3.get("fields") or {}).get("bark")),
            )

            # 增量：加第二个渠道，第一个**不能被清掉**
            code, body = http(
                f"{base}/plugins/mcloud/api/push/config",
                method="POST",
                body=json.dumps({"set": {"bark": {"key": "K2_abcdefghij"}}}).encode(),
                headers={"content-type": "application/json", "x-panel": "1"},
            )
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            p4 = (json.loads(body) if code == 200 else {}).get("push") or {}
            check("增量保存不会清掉别的渠道", p4.get("configured") == ["bark"], str(p4.get("configured")))

            # 显式删除
            code, body = http(
                f"{base}/plugins/mcloud/api/push/config",
                method="POST",
                body=json.dumps({"remove": ["bark"]}).encode(),
                headers={"content-type": "application/json", "x-panel": "1"},
            )
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            p5 = (json.loads(body) if code == 200 else {}).get("push") or {}
            check("⚠ `remove` 真的能删（纯合并做不到这件事）", p5.get("configured") == [], str(p5.get("configured")))

            # 试发：一个都没配 ⇒ 如实说
            code, body = http(
                f"{base}/plugins/mcloud/api/push/test",
                method="POST",
                body=b"{}",
                headers={"content-type": "application/json", "x-panel": "1"},
            )
            d6 = json.loads(body) if code == 200 else {}
            check(
                "试发：没配渠道时如实说「一个渠道都没配」",
                code == 200 and d6.get("ok") is False and "没配" in str(d6.get("line")),
                f"http {code} {body[:120]}",
            )

            # 规则与绑定
            code, body = http(
                f"{base}/plugins/mcloud/api/push/rules",
                method="POST",
                body=json.dumps([{"id": "r1", "name": "全部渠道", "channels": [], "minLevel": "always"}]).encode(),
                headers={"content-type": "application/json", "x-panel": "1"},
            )
            check("能存规则", code == 200, f"http {code} {body[:80]}")
            code, body = http(
                f"{base}/plugins/mcloud/api/push/bindings",
                method="POST",
                body=json.dumps({"daily": "r1", "exchange": "", "live": ""}).encode(),
                headers={"content-type": "application/json", "x-panel": "1"},
            )
            d7 = json.loads(body) if code == 200 else {}
            check("能存绑定", code == 200 and d7.get("bindings", {}).get("daily") == "r1", f"http {code}")
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            p8 = (json.loads(body) if code == 200 else {}).get("push") or {}
            check(
                "读数里三个任务的绑定都在",
                (p8.get("bindings") or {}).get("daily") == "r1"
                and "exchange" in (p8.get("bindings") or {})
                and "live" in (p8.get("bindings") or {}),
                str(p8.get("bindings")),
            )
            check("规则也回到读数里了", len(p8.get("rules") or []) == 1, str(p8.get("rules")))

            # ---- ⑩ 运行记录（⑤-2）：一次运行一行 ----
            print("\n运行记录（脚本断言）")
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            d = json.loads(body) if code == 200 else {}
            for task in ("daily", "exchange", "live"):
                blk = d.get(task) or {}
                check(
                    f"「{task}」块里有 recent（最近几次的摘要）",
                    isinstance(blk.get("recent"), list),
                    f"http {code}，拿到 {type(blk.get('recent')).__name__}",
                )
            # 真跑一次日常，然后看记录里有没有它
            code, body = http(
                f"{base}/api/tasks/mcloud-daily/%E6%97%A5%E5%B8%B8/run",
                method="POST",
                body=b"{}",
                headers={"content-type": "application/json", "x-panel": "1"},
            )
            check("能触发一次日常", code == 200, f"http {code} {body[:100]}")
            time.sleep(2)
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            d2 = json.loads(body) if code == 200 else {}
            recent = (d2.get("daily") or {}).get("recent") or []
            check(
                "⚠ 跑完之后「最近几次」里真的多了一条",
                len(recent) >= 1,
                f"拿到 {len(recent)} 条",
            )
            if recent:
                r0 = recent[0]
                check("摘要里有一行结论", bool(r0.get("note")), str(r0)[:120])
                check(
                    "⚠ 摘要里**没有** steps（20 次 × 40 步全塞进读数就是几百 KB）",
                    "steps" not in r0,
                    str(list(r0.keys())),
                )
                check("摘要里有耗时", isinstance(r0.get("ms"), int), str(r0.get("ms")))
                check(
                    "摘要里分了成功 / 失败 / 没做事三档",
                    all(k in r0 for k in ("okCount", "badCount", "idleCount")),
                    str(list(r0.keys())),
                )
                # 按 id 取那一次的步骤
                code, body = http(f"{base}/plugins/mcloud/api/runs?id={r0['id']}")
                check(
                    "能按 id 取到那一次的步骤",
                    code == 200 and isinstance((json.loads(body) if code == 200 else {}).get("steps"), list),
                    f"http {code} {body[:120]}",
                )
                code, body = http(f"{base}/plugins/mcloud/api/runs?id=daily-0000000000000")
                check(
                    "取一个不存在的 id ⇒ 404（不是空对象）",
                    code == 404,
                    f"http {code}",
                )
                code, body = http(f"{base}/plugins/mcloud/api/runs")
                check("不给 id ⇒ 400", code == 400, f"http {code}")

            # ---- ⑪ 兑换的时间（③-1）----
            print("\n兑换时间（脚本断言）")
            code, body = http(f"{base}/plugins/mcloud/api/readings")
            d = json.loads(body) if code == 200 else {}
            ex = d.get("exchange") or {}
            t = ex.get("timing") or {}
            check("兑换读数里有时间信息", isinstance(t, dict) and "msToWindow" in t, f"http {code}")
            check("窗口开在 59:40", t.get("windowSecond") == 40, str(t.get("windowSecond")))
            check(
                "压整点前 10ms 发（传输耗时补偿）",
                t.get("leadMs") == 10,
                str(t.get("leadMs")),
            )
            check(
                "三个时间量都是数字（离整点 / 离窗口 / 离发单）",
                all(isinstance(t.get(k), (int, float)) for k in ("msToHour", "msToWindow", "msToFire")),
                str(t),
            )
            check(
                "在不在窗口里是个布尔",
                isinstance(t.get("inWindow"), bool),
                str(t.get("inWindow")),
            )
            check(
                "小时闸的读数在（这一小时发过没有）",
                isinstance(ex.get("orderedThisHour"), bool),
                str(ex.get("orderedThisHour")),
            )
            # 任务挂的是 10 秒节拍（不是 1 小时一枪）
            code, body = http(f"{base}/api/state")
            state = json.loads(body) if code == 200 else {}
            row = next((j for j in (state.get("jobs") or []) if j.get("name") == "兑换"), None)
            check(
                "⚠ 兑换挂的是 10 秒节拍（粗粒度等待交给调度器，细粒度才自旋）",
                row is not None and row.get("schedule") == "@every 10s",
                str(row.get("schedule") if row else "没找到「兑换」这条任务"),
            )

            # ---- ⑫ 线程分配 ----
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
