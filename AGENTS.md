# AGENTS.md — mcloud-plugin（已迁入 panel-plugins/）

## 目录与路径

- 仓库根：`~/mobile/workspace/panel-plugins/mcloud-plugin`（旧路径 `~/mobile/workspace/mcloud-plugin` 是**软链**，只给老会话兜底，新工作一律用新路径）。
- 面板仓：`~/mobile/workspace/panel-llrt`（相对本仓库是 `../../panel-llrt`）。
- 日常实例：`~/panel-3030`（launchd 服务 `dev.panel`，面板二进制 `~/panel-3030/panel`）。
- `scripts/deploy-panel.sh` / `e2e-mock.sh` / `picks-e2e.sh` 都会**自动探测**面板仓/二进制
  （两级候选），显式覆盖用 `PANEL_REPO` / `PANEL_BIN` / `PANEL_PLUGINS_DIR`。

## 验证命令（在仓库根跑）

```bash
npm run all          # gen + typecheck + build + test + check-build + check-layers
npm test             # node --test（~1305 条）
npm run deploy:panel -- --restart   # 构建 + 门禁 + 装进 ~/panel-3030 并重启
./scripts/e2e-mock.sh               # 对 mock 上游的全链路（不碰真账号）
```

面板仓侧的界面门禁：`node ../../panel-llrt/scripts/check-plugin-style.mjs`
（deploy:panel 已自动跑）。`ui-check.mjs` / `ui-kit-check.mjs` 也在这里。

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
- 迁移幂等：`migrateUserConfig` 在 `makeStore` 里自动跑（升级即迁，无需操作）；
  并发首启用独立迁移锁 `.lock-migrate` 串行化，别改成复用存储目录的 `.lock`（自锁）。

## 版本 / 发布

- 版本三处一致（构建期校验）：`package.json` / `src/version.ts` / 四份 `plugins/panelllrt/*.panel.json`。
- tag `v<version>`；面板产物 `dist/panel-llrt/`（目录式，gitignore，`npm run build` 重建）。
