# AGENTS.md — mcloud-plugin（已迁入 panel-plugins/）

## 目录与路径

- 仓库根：`~/mobile/workspace/panel-plugins/mcloud-plugin`（旧路径 `~/mobile/workspace/mcloud-plugin` 是**软链**，只给老会话兜底，新工作一律用新路径）。
- 面板仓：`~/mobile/workspace/panel-llrt`（相对本仓库是 `../../panel-llrt`）。
- 日常实例：`~/panel-3030`（launchd 服务 `dev.panel`，面板二进制 `~/panel-3030/panel`）。
- `scripts/deploy-panel.sh` / `e2e-mock.sh` / `picks-e2e.sh` 都会**自动探测**面板仓/二进制
  （两级候选），显式覆盖用 `PANEL_REPO` / `PANEL_BIN` / `PANEL_PLUGINS_DIR`。

## 验证命令（在仓库根跑）

```bash
npm run all          # gen + check:types + typecheck + build + test + check:versions + check-build + check-layers
npm test             # node --test（1400+ 条；具体数看输出，别在文档里钉死）
npm run deploy:panel -- --restart   # 构建 + 门禁 + 装进 ~/panel-3030 并重启
# 三条 mock 全链路（都不碰真账号；需要面板二进制，用 PANEL_BIN 指）
PANEL_BIN=$HOME/panel-3030/panel ./scripts/e2e-mock.sh   # 日常/签到/算力/趣玩AI/直播 全链路 + ⑮「只跑一族」
PANEL_BIN=$HOME/panel-3030/panel bash scripts/picks-e2e.sh   # 「选奖品」缓存那条链
PANEL_BIN=$HOME/panel-3030/panel bash scripts/e2e-prize.sh   # 领奖链（含本地解 JPEG 滑块）
```

面板仓侧的界面门禁：`node ../../panel-llrt/scripts/check-plugin-style.mjs`
（deploy:panel 已自动跑）—— **这条才是查插件的**，能在本仓根直接跑。

⚠ `ui-check.mjs` / `ui-kit-check.mjs` **不在这里跑**：它们查的是**面板自己的界面**
（要找 `target/debug/panel` 与面板仓的 `plugins/webui-demo`），必须在面板仓里跑。
在插件仓根跑会以 `挂了：先构建…` / `ENOENT …/webui-demo` 失败 —— 2026-11-26 实测。

**CI 跑什么**（`.github/workflows/ci.yml`，推送 main / tag 触发）：
`gen` 可复现 → `typecheck` → `npm test` → **`check-phone-leak`（R5）** →
**`check:versions`（四处版本一致）** → `build` + `check-build`。
⚠ 它**跑不了** `check:types` 与 `check-plugin-style` —— 那两个要读面板仓的文件
（`../../panel-llrt/tools/plugin-shared/*`），CI 里没有面板仓。**发版前在本机手动跑一次。**

**`npm run all` 之外还有这些**（都真跑过，别当装饰）：

```bash
npm run typecheck:standalone && npm run check-build:standalone   # CLI 那一半
node ../../panel-llrt/scripts/check-plugin-compat.mjs --strict   # R7：min_panel 与能力一致（发版前必过）
python3 scripts/ci_state_check.py loaded /tmp/state.json         # 对着活面板存的 state 断言（CI 用的同一份）
python3 scripts/ci_state_check.py selftest /tmp/selftest.json    # 沙箱自检
bash scripts/panel-supports-dir-plugins.sh $HOME/panel-3030/panel  # 面板支不支持目录式插件
```

## 本仓库特有的坑

- **四个插件共用一份存储**：`<data>/plugin-data/mcloud/`（`shared.json` + `state/<账号>.json`）。
  `shared.json` 的 `mcloud.accounts` 是 **mgmusic 0.6.0 的跨仓只读契约** —— 位置、键名、
  字段都不能动（`test/accountsContract.test.ts` 钉着）。
- **用户配置只有一份**：`plugin-data/mcloud/config.json`（`schema_version` 幂等）。
  绑定表在 `src/store/userConfigKeys.ts`（CONFIG_BINDINGS / RETIRED_BINDINGS）；
  加/搬设置先改那张表，业务代码走 `scoped()` 的 getState/setState 即可。
  裸 store 上写配置键会**直接抛错**（`assertNotConfigKey`）—— 那是故意的。
- **git add 只加明确路径**：本仓库可能与其它 agent 并行工作；`git add -A` 会把别人的
  半成品一起提交。docs/ 与 mock/ 曾多次出现并行改动。
- **`deploy:panel` / 发版前先看 `git status`**：`scripts/deploy-panel.sh` 直接跑
  `node scripts/build.mjs`，构建的是**工作树**、不是 HEAD ⇒ 树里有别人的半成品时部署，
  等于把那半成品装进实例。只提交自己的路径，部署前先确认树干净。
  （2026-11-26 观察到并行会话正在写 `tasks/cloudActs.ts`；那次**没有**混进实例 ——
  我部署的 22:14 早于那个文件出现的 22:19。写在这里是**风险提示**，不是已发生的事故。）
- **`scripts/check-phone-leak.mjs` 不是我们的文件**：它由 `node scripts/sync-types.mjs`
  从面板仓 `tools/plugin-shared/` 同步过来，本地改了 `npm run check:types` 会判红
  （2026-11-26 踩过：改完直接提交，`npm run all` 在第一步就挂了）。
  它默认只扫**已跟踪**文件 —— 本机自测（文件还没 `git add`）要加 `--all`，否则会假绿。
- 迁移幂等：`migrateUserConfig` 在 `makeStore` 里自动跑（升级即迁，无需操作）；
  并发首启用独立迁移锁 `.lock-migrate` 串行化，别改成复用存储目录的 `.lock`（自锁）。

## 版本 / 发布

- 版本**四处**一致，有脚本钉着：`npm run check:versions`（`package.json` / `src/version.ts` /
  `mcloud.panel.json` / 三份 `plugins/mcloud-*.panel.json`）。它在 `npm run all` 与 CI 里都跑。
- tag `v<version>`；面板产物 `dist/panel-llrt/`（目录式，gitignore，`npm run build` 重建）。
