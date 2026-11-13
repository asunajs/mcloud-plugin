# `mcloud-llrt` —— 给 panel-llrt（0.4.x）的界面变体

**这不是手写的第二份源**，是 `plugins/mcloud/`（0.3.x 老面板那份）加上面板仓的交接补丁得到的：

```
panel-llrt/docs/handoff/mcloud-webui-0.4.diff   （551 行，+302）
```

补丁按顺序做四件事（与交接文档 §「0.4.x 变体到底差在哪」一一对应）：

1. `<head>` 从 `/css/{reset,theme,components}.css` 换成面板的 **`/app.css`**（token + 组件的唯一来源）
2. token 映射**方向**：`--text: var(--fg)` / `--text-dim: var(--fg-2)` / `--text-mute: var(--dim)` /
   `--border-soft: var(--line)` / `--border: var(--line-strong)` / `--bg-deep: var(--bg)`
   （⚠ 写反 = `--fg` 变无效值 = 整页配色塌，第 155 轮的真实事故）
3. `boot.js` 自己挂 `data-theme`：`?theme=` → `localStorage.panel-llrt-theme` → 系统，并跟随面板切换
4. `?diag=1` 自检 + `--style-ver` / `appVer` 版本号

## 复现方式（改了源就要重来一遍）

```bash
cd /tmp && rm -rf v04 && mkdir v04 && cp -R ~/mobile/workspace/mcloud-plugin/plugins/mcloud/* v04/
# 把 docs/handoff/mcloud-webui-0.4.diff 的四个文件路径改成一层的，然后
cd v04 && patch -p1 < /tmp/v04.patch
```

`patch` 之后与面板仓暂存版的 sha256 **逐字节一致**（2026-11-13 核对过）：

| 文件 | sha256 前 12 位 |
|---|---|
| `index.html` | `0c2fd5c251dd` |
| `style.css` | `8686d162ea4a` |
| `app.js` | `50063e23977a` |
| `boot.js` | `a0038ab2aeb1` |

## 纪律

- **不要**直接改 `panel-llrt/plugins/mcloud.webui/`（那是 `build-panelllrt` 的产物，会被 `rmSync` 冲掉）
- 改界面改**这里**，然后 `npm run build:panelllrt`
- 配色/控件只写布局：颜色一律 `var(--token)`，不许字面量、不许 `!important`、不许 `prefers-color-scheme`
  （见技能 `panel-plugin-ui` 与面板仓 `scripts/check-plugin-style.mjs`）
