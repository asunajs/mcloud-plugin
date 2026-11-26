# 装到面板里（发布产物怎么用）

> 一句话：**下载 `mcloud-plugin-<版本>-panel08.zip` → 面板「插件管理」→ 上传 → 选中那个 zip。**
> 面板会自己解压、重启插件、把三条任务挂上调度。
>
> ⚠ 面向 **panel-llrt 0.8.3 起**（清单里 `min_panel: 0.8.3`）。
> 发布包是**单文件平铺**：`<name>.js` + `<name>.panel.json` + `mcloud.webui/` 都在 zip 根
> —— 面板只扫 `plugins/*.js`，塞进 `js/` 子目录等于「装了但面板看不见」。
> （面板也认目录式 `plugins/<name>/index.js`，那是 `npm run deploy:panel` 往本机实例装时的形状；
> 发布包保持平铺是为了兼容线更宽。）

## 一、用 Release 里的 zip（推荐）

1. 打开 <https://github.com/asunajs/mcloud-plugin/releases>，下载最新的
   `mcloud-plugin-<版本>-panel04.zip`（同目录有 `.sha256`，装之前可以先对一下）；
2. 面板左侧「插件管理」→ 点上传，选中那个 zip（**整包，不用解压**）；
3. 等两秒。四张卡片出现、状态「已启用」。面板任务列表里有三条（日常 / 兑换 / 直播）：

   | 任务 | 表达式 | 说明 |
   |---|---|---|
   | 日常 | `0 8,20 * * *` | 签到 / 任务拓展 / App 任务 / 云手机 / 算力大作战 / 趣玩AI（可逐族关） |
   | 兑换 | `0 10 * * *` | 只负责**叫醒**与记录；换什么在插件里配（见下） |
   | 直播 | `30 10,15 * * *` | 听口令 + 领小红花 |

   **兑换的计划在「云盘 → 兑换 → 定时抢兑」里配**（面板那条任务只负责叫醒与记录）。
   一条计划 = 一个账号 + 一个目标 + 一个整点（提前量/截止/次数也在这一条里）；
   两个号换不同的东西或不同的时间，就建两条计划。新装默认暂停；点「添加计划」并保存后
   面板那条「兑换」会自动启用，cron 取所有启用计划整点的并集。

4. 打开左侧 **「插件界面 → 移动云盘」**，**导入会话**（账号页的二维码 / Cookie），
   然后点一次「日常」跑起来。

zip 里只有这些文件，没有源码、没有文档：

```
mcloud.js  mcloud-daily.js  mcloud-exchange.js  mcloud-live.js
mcloud.panel.json  mcloud-daily.panel.json  mcloud-exchange.panel.json  mcloud-live.panel.json
mcloud.webui/{index.html,style.css,app.js,boot.js}
```

清单里的 `config.fields` 决定「插件卡片 → 配置」显示什么：现在只有两格
`daily_budget_s`（日常预算 60–600 秒）与 `exchange_enabled`（定时抢兑开关），
写进**统一**的 `plugin-data/mcloud/config.json`（`schema_version` 幂等）。
⚠ 早先那套"插件配置页与插件界面各写一份、靠指纹三方合并"的机制**已删** ——
现在只有一份配置，两个入口写的是同一格。迁移实现见 `src/host/fs/configMigrate.ts` 文件头。

## 二、zip 为什么"面板能直接用"

面板的上传口（`/api/plugins/upload`）解压规则是：

- 相对 `PLUGINS_DIR` 展开 —— 所以 zip 根目录就是那四份 `.js`、四份清单和 `mcloud.webui/`；
- 会**剥掉统一的外层目录**（`mcloud-plugin-0.1.0/js/…` 也认）；
- 拒绝符号链接、拒绝任何以 `.` 开头的路径段（`.env`、`.git/…`）；
- `.DS_Store` / `__MACOSX` 这类压缩噪音**跳过**（不算失败）；
- 上限：总解压 64 MiB、单文件 32 MiB、2000 条目。

`npm run pack:panel04` 就是按这套规则打的，而且**打之前按同一套规则自己验一遍**
（`scripts/pack.mjs`）—— 不是"打出来就完事"，等上传被拒时才查就晚了。

## 三、不用 zip 的手动安装

```sh
git clone https://github.com/asunajs/mcloud-plugin
cd mcloud-plugin
npm ci && npm run build        # 产出 dist/panel-llrt/（四份 .js + 四份清单 + mcloud.webui/）
# 把 dist/panel-llrt/ 下的东西整份拷进面板的插件目录：
#   ~/panel-3030/plugins/{mcloud,mcloud-daily,mcloud-exchange,mcloud-live}.js
#   ~/panel-3030/plugins/*.panel.json
#   ~/panel-3030/plugins/mcloud.webui/
```

也可以直接 `npm run deploy:panel`（构建 + 样式门禁 + 整份拷贝 + 逐个 cmp）——
它会看目标面板**支不支持目录式插件**（`plugins/<name>/index.js` + 相对 import）来决定产出
单文件还是"共用核心"的目录形态；要强制一种就设 `MCLOUD_PKG=single|dir`。
面板扫描的是**构建产物**，所以改完源码要重新 build 再拷；只拷 `src/` 跑不起来。

## 三之二、从旧版 mcloud-sign 的 `asign.json` 搬过来

第一次用这个插件、手里只有老版 `asign.json`：

1. 面板 → 插件 → 移动云盘 →「账号」页工具栏 →**「导入旧配置」**；
2. 把 `asign.json` 整份贴进去 →「先看看会搬什么」（只算不写）→「导入」；
3. 会搬：账号、云手机/算力大作战的开关、`standalone.http|ws` → `cli.*`；
   **不认识的键不搬**，会在提示里列出来。

命令行等价物（同一份实现）：

```sh
mcloud-sign config:import --config asign.json --data-dir ~/panel-3030/data/plugin-data/mcloud --dry-run
```

⚠ `asign.config.js|mjs` 面板里贴不了（不是 JSON），先用 CLI 那条；面板只收 JSON 文本。

## 四、升级

新版本同样是一个 zip，**直接再传一次**（默认覆盖）。传完插件会自动热更，
不用重启面板；会话、读数、任务设置都在 `plugin-data/mcloud/`（`shared.json` + `state/<账号>.json`
+ `config.json`）里，不会丢。

## 五、自己发一个版本（维护者）

```sh
npm run all             # 门：类型检查 / 测试 / 产物一致
# 版本号三处要一起改（构建期会校验）：package.json / src/version.ts / 四份 *.panel.json
npm run build && npm run pack            # 出 dist/mcloud-plugin-<版本>-panel08.zip
git add package.json src/version.ts mcloud.panel.json plugins/*.panel.json   # 只加明确路径
git commit -m "release v<版本>" && git tag v<版本> && git push --follow-tags
```

推了 tag 之后 `.github/workflows/release.yml` 会自动：跑门（类型/测试/产物一致/版本对齐）→
`npm run build:panelllrt` + `npm run pack` → 挂到 Release 上（已有就 `--clobber` 覆盖，发布幂等）。

⚠ 它**不会**帮你试装到一个空面板 —— 那一步是本机 `npm run deploy:panel -- --restart` 做的
（构建 + 样式门禁 + 整份拷贝 + 逐个 cmp + 重启 + 等 readyz）。
⚠ 发完还要**同步货架** `asunajs/panel-single-plugins` 的 `catalog.json`（版本 / 资产名 / sha256），
否则商店卡片还写着旧版本。
