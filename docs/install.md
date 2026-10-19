# 装到面板里（发布产物怎么用）

> 一句话：**下载 `mcloud-plugin-vX.Y.Z.zip` → 面板「插件管理」→ 上传 → 选中那个 zip。**
> 面板会自己解压、重启插件、把三条任务挂上调度。

## 一、用 Release 里的 zip（推荐）

1. 打开 <https://github.com/asunajs/mcloud-plugin/releases>，下载最新的
   `mcloud-plugin-vX.Y.Z.zip`；
2. 面板左侧「插件管理」→ 点上传，选中那个 zip（**整包，不用解压**）；
3. 等两秒。四张卡片出现、状态「已启用」。面板任务列表里有两条（日常 / 直播）：

   | 任务 | 表达式 | 说明 |
   |---|---|---|
   | 日常 | `0 8,20 * * *` | 签到、领取、App 任务… |
   | 直播 | `30 10,15 * * *` | 听口令 + 领小红花 |

   **兑换不在面板任务列表里**：它在「云盘 → 兑换 → 定时抢兑」里配置（奖品、账号、
   时间、提前量），新装默认暂停；选好奖品和账号后点「启用定时」才开始跑。

4. 打开左侧「云盘」，**导入会话**（账号页的二维码 / Cookie），然后点一次「日常」跑起来。

zip 里只有这些文件，没有源码、没有文档：

```
js/mcloud.js  js/mcloud-daily.js  js/mcloud-exchange.js  js/mcloud-live.js
mcloud/index.html  mcloud/app.js  mcloud/style.css
```

## 二、zip 为什么"面板能直接用"

面板的上传口（`/api/plugins/upload`）解压规则是：

- 相对 `PLUGINS_DIR` 展开 —— 所以 zip 根目录就是 `js/` 和 `mcloud/`；
- 会**剥掉统一的外层目录**（`mcloud-plugin-0.1.0/js/…` 也认）；
- 拒绝符号链接、拒绝任何以 `.` 开头的路径段（`.env`、`.git/…`）；
- `.DS_Store` / `__MACOSX` 这类压缩噪音**跳过**（不算失败）；
- 上限：总解压 64 MiB、单文件 32 MiB、2000 条目。

`npm run pack` 就是按这套规则打的，而且**打之前按同一套规则自己验一遍**
（`scripts/pack.mjs`）—— 不是"打出来就完事"，等上传被拒时才查就晚了。

## 三、不用 zip 的手动安装

```sh
git clone https://github.com/asunajs/mcloud-plugin
cd mcloud-plugin
npm ci && npm run build        # 产出 plugins/js/*.js
# 把 plugins/ 下这两样拷进面板的 PLUGINS_DIR：
#   js/mcloud*.js
#   mcloud/（index.html app.js style.css）
```

面板扫描 `PLUGINS_DIR/js/*.js`，所以**改完源码要重新 build 再拷**；
只拷 `src/` 是跑不起来的（面板加载的是构建产物）。

## 四、升级

新版本同样是一个 zip，**直接再传一次**（默认覆盖）。传完插件会自动热更，
不用重启面板；会话、读数、任务设置都在数据库里，不会丢。

## 五、自己发一个版本（维护者）

```sh
npm run all             # 门：类型检查 / 测试 / 产物一致 / 调度断言
npm version --no-git-tag-version 0.2.0   # 改 package.json（tag 会跟它比）
npm run build && npm run pack            # 出 dist/mcloud-plugin-0.2.0.zip
git add -A && git commit -m "release v0.2.0" && git tag v0.2.0 && git push --follow-tags
```

推了 tag 之后 `.github/workflows/release.yml` 会自动：跑门 → 打包 →
**把这个 zip 传进一个空面板试装一遍**（装不起来就不发）→ 挂到 Release 上。
