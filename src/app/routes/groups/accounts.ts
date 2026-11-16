// accounts 那一组路由（3 条）：/task/accounts · /accounts · /accounts
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { loadBaseUrl } from '../../../mcloud/session.ts';
import { TASK_NAMES } from '../../../mcloud/tasks/taskList.ts';
import { SCHEDULED_TASKS, saveTaskAccounts, taskAccountsView } from '../../../mcloud/taskAccounts.ts';
import { runAuthRefresh } from '../../../mcloud/authRefresh.ts';
import { parseAuth } from '../../../mcloud/auth.ts';
import { currentAccount, loadAccounts, removeAccount, selectAccount, setAccountDisabled, setAccountLabel, upsertAccount } from '../../../mcloud/accounts.ts';
import { loadListenSeconds } from '../../../mcloud/tasks/liveListen.ts';
import { loadAuthRaw } from '../../../mcloud/sessionExchange.ts';
import { PC_AUTH_PREFIX } from '../../../mcloud/login.ts';
import type { Store } from '../../../store/types.ts';
import { rawStoreOf, scoped } from '../../../store/scoped.ts';
import { syncTaskReadiness } from '../../../mcloud/taskReadiness.ts';
import { accountsView, json, readBody } from '../support.ts';
import type { RouteDeps, RouteEntry } from '../support.ts';

/** accounts 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
export function accountsRoutes(deps: RouteDeps, base: string, verify: () => { ok: boolean; note: string }): RouteEntry[] {
  void verify;
  return [
{
      // 写"这条任务跑哪些账号"。
      //
      // ⚠ 校验两件事：任务名必须是我们认识的那三个（不然键会被人拼出来乱写），
      //   以及**选中的 id 必须真的存在** —— 存一堆不存在的 id 会让任务静默不跑，
      //   而界面上看起来"选好了"。
      path: `${base}/task/accounts`,
      method: 'POST',
      handler: (req) => {
        const b = readBody(req) as {
          task?: unknown;
          mode?: unknown;
          follow?: unknown;
          all?: unknown;
          ids?: unknown;
        };
        const task = typeof b.task === 'string' ? b.task : '';
        const mode = b.mode === 'manual' ? 'manual' : 'auto';
        // ⚠ 校验的是**排期任务名**（`日常`/`兑换`/`直播`），不是内部步骤名。
        //   这里曾经误用 `TASK_NAMES`（那是 `sign`/`receive` 那一套）⇒ 保存账号选择
        //   每次都回「不认识的任务：日常」，而界面上只看到"点了没反应"。
        if (!(SCHEDULED_TASKS as readonly string[]).includes(task)) {
          return json(400, { error: `不认识的任务：${task || '(空)'}` });
        }
        const all = b.all === true;
        const follow = b.follow === true;
        const known = new Set(loadAccounts(deps.store).map((a) => a.id));
        const ids = Array.isArray(b.ids)
          ? b.ids.filter((x): x is string => typeof x === 'string' && known.has(x))
          : [];
        if (mode === 'manual') {
          saveTaskAccounts(
            deps.store,
            task,
            follow ? { follow: true, all: false, ids: [] } : { follow: false, all, ids },
            deps.now(),
            'manual',
          );
        } else {
          saveTaskAccounts(deps.store, task, { all, ids }, deps.now(), 'auto');
        }
        const label = mode === 'manual' ? `${task}·本次` : `${task}·自动`;
        deps.log(
          `任务账号（${label}）：${mode === 'manual' && follow ? '跟随自动' : all ? '全部' : `${ids.length} 个`}`,
        );
        syncTaskReadiness(deps.store, [task]);
        return json(200, {
          ...taskAccountsView(deps.store as unknown as Store, task),
          note:
            mode === 'manual' && follow
              ? `${label}：跟随自动`
              : all
                ? `${label}：全部账号`
                : `${label}：${ids.length} 个账号`,
        });
      },
    },

{
      // 账号列表（多账号第 2 片，见 accounts.ts 模块头）。
      //
      // ⚠ 只回**掩码**：凭据本身不许出这个口子（它已经能从别处拿，但少一个出口就少一处泄露面）。
      path: `${base}/accounts`,
      method: 'GET',
      handler: () => json(200, { ...accountsView(deps.store) }),
    },

{
      path: `${base}/accounts`,
      method: 'POST',
      handler: (req) => {
        const body = readBody(req);
        const op = typeof body.op === 'string' ? body.op : '';
        const now = deps.now();
        if (op === 'add') {
          const auth = typeof body.auth === 'string' ? body.auth.trim() : '';
          if (auth === '') return json(400, { error: '要传 auth（原生凭据那一串）' });
          // ⚠ **先解析再落盘**：解不开的串存进去只会变成一个"永远登录不上、
          //   也看不出为什么"的账号。参考实现也是先 `parse_auth` 再建账号。
          const info = parseAuth(auth);
          if (info === undefined) {
            return json(400, {
              error:
                '这段凭据解不开。它应该是 `Basic <base64>`（或只有 base64 那段），' +
                '里面是 `<平台>:<手机号>:<token>`',
            });
          }
          const pcRaw = typeof body.pcPlatform === 'string' ? body.pcPlatform : '';
          if (pcRaw !== '' && pcRaw !== 'win' && pcRaw !== 'mac') {
            return json(400, { error: 'pcPlatform 只能是 win 或 mac' });
          }
          // ⚠ PC 端**要问**形态：凭据里那一格恒是 `pc`（Windows 与 macOS 都是它），
          //   分不出 win/mac，而它决定后续每一次请求的 UA 与设备头 ——
          //   选错的话这个账号以后一直用错的身份发请求。
          //
          //   界面上**没有**解析逻辑（`app.js` 是静态文件，import 不到解析器），
          //   所以这里用 `needPcPlatform` 让界面把那个选择露出来 ——
          //   解析只在后端做一次，界面不复制一份（两份会漂移）。
          if (info.platform === PC_AUTH_PREFIX && pcRaw === '') {
            return json(400, {
              error: '这条是 PC 端 —— 选一下它当初是 Windows 还是 macOS（决定以后的请求头）',
              needPcPlatform: true,
            });
          }
          const r = upsertAccount(
            deps.store,
            auth,
            now,
            undefined,
            pcRaw === '' ? undefined : (pcRaw as 'win' | 'mac'),
          );
          // ⚠ 日志里只说"谁"，不说凭据
          deps.log(`账号：${r.created ? '添加' : '更新'} ${r.account.label}`);
          if (loadAccounts(deps.store).length === 1) selectAccount(deps.store, r.account.id, now);
          syncTaskReadiness(deps.store);
          return json(200, { ...accountsView(deps.store), note: `${r.created ? '已添加' : '已更新'} ${r.account.label}` });
        }
        // **按账号**写设置。
        //
        // ⚠ 与 `refresh` 同一个理由：这两个键是按账号的，而"改哪一条"必须由
        //   调用方**指名**，不能靠"当前选中是谁" —— 那会改错人而且看不出来。
        if (op === 'set-settings') {
          const id = typeof body.id === 'string' ? body.id : '';
          const found = loadAccounts(deps.store).find((a) => a.id === id);
          if (!found) return json(400, { error: `列表里没有这个账号：${id}` });
          const one = scoped(rawStoreOf(deps.store), id);
          const secs = typeof body.listenSeconds === 'number' ? body.listenSeconds : null;
          const room = typeof body.listenRoom === 'number' ? body.listenRoom : null;
          if (secs !== null) {
            // 后端上限 3600（与 `loadListenSeconds` 的夹取一致）—— 这里也夹一次，
            // 免得库里存着一个读的时候会被悄悄改掉的值（那会让人以为"没存上"）。
            const clamped = Math.max(10, Math.min(3600, Math.round(secs)));
            one.setState('mcloud.live.listen_seconds', String(clamped), now);
          }
          if (room !== null) {
            one.setState('mcloud.live.listen_room', room > 0 ? String(Math.round(room)) : '', now);
          }
          if (typeof body.wsHeartbeat === 'string') {
            one.setState('mcloud.live.ws_heartbeat_reply', body.wsHeartbeat.trim(), now);
          }
          deps.log(`账号设置（${found.label}）：窗口 ${secs ?? '不变'}s / 房间 ${room ?? '不变'}`);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `${found.label} 的设置已存下`,
          });
        }

        // **按账号**刷新凭据。
        //
        // ⚠ 这一条必须有"指定账号"的能力：`/auth/refresh` 刷的是**当前**账号，
        //   而卡片上的「刷新」是要刷**那一条**的。老做法只能"先切过去再刷" ——
        //   那会**改掉用户当前选中的账号**，而用户只是想让另一个号刷新一下。
        //   现在 `scoped(store, id)` 直接给出"作用在指定账号上"的 store。
        if (op === 'refresh') {
          const id = typeof body.id === 'string' ? body.id : '';
          const found = loadAccounts(deps.store).find((a) => a.id === id);
          if (!found) return json(400, { error: `列表里没有这个账号：${id}` });
          // ⚠ **不要**用 `scoped(store, id)` 来"指定账号"：`loadAuthRaw` 先看
          //   `currentAccount()`，而"当前是谁"是**全局**键（`mcloud.account.current`）
          //   ⇒ 刷的是当前账号、提示写的却是被点的那条，新串还落进被点那条的袋里
          //   （谁都不读）。这里把"刷哪串、写回哪条"显式传下去（F-077）。
          const r = runAuthRefresh(
            {
              store: deps.store,
              transport: deps.transport,
              nowIso: deps.now(),
              baseUrl: loadBaseUrl(deps.store),
            },
            true,
            undefined,
            { auth: found.auth, accountId: found.id },
          );
          deps.log(`凭据续期（${found.label}）：${r.note}`);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `${found.label}：${r.note}`,
          });
        }

        // 停用 / 启用。⚠ 与"删掉"不是一回事：停用**保留**状态袋
        //（票、进度、`ordered_hour` 都还在），所以不能用"删了重加"来模拟。
        if (op === 'disable') {
          const id = typeof body.id === 'string' ? body.id : '';
          // ⚠ 第一版这里写的是 `const on = body.disabled !== true` —— **反了**：
          //   传 `disabled:true` 实际执行的是"启用"。测试当场抓到（传 true 回
          //   "已启用"）。命名也是坑：一个叫 `on` 的变量存的是"停用与否"，
          //   读代码时看不出反了。这里直接用 `disabled` 这个名字。
          const disabled = body.disabled === true;
          const a = setAccountDisabled(deps.store, id, disabled, now);
          if (!a) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(`账号：${disabled ? '停用' : '启用'} ${a.label}`);
          syncTaskReadiness(deps.store);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `${disabled ? '已停用' : '已启用'} ${a.label}`,
          });
        }
        // 改昵称。空串 = 回落成手机号（与参考实现的 PATCH 语义一致）。
        if (op === 'edit') {
          const id = typeof body.id === 'string' ? body.id : '';
          const label = typeof body.label === 'string' ? body.label : '';
          const a = setAccountLabel(deps.store, id, label, now);
          if (!a) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(`账号：改名为 ${a.label}`);
          return json(200, {
            ...accountsView(deps.store as unknown as Store),
            note: `已改名为 ${a.label}`,
          });
        }
        if (op === 'select') {
          const id = typeof body.id === 'string' ? body.id : '';
          if (!selectAccount(deps.store, id, now)) return json(400, { error: `列表里没有这个账号：${id}` });
          deps.log(id === '' ? '账号：清掉"当前"（回到单账号那格）' : `账号：当前切到 ${id}`);
          return json(200, { ...accountsView(deps.store), note: id === '' ? '已清掉当前账号' : `当前：${id}` });
        }
        if (op === 'remove') {
          const id = typeof body.id === 'string' ? body.id : '';
          removeAccount(deps.store, id, now);
          deps.log(`账号：删掉 ${id}`);
          syncTaskReadiness(deps.store);
          return json(200, { ...accountsView(deps.store), note: `已删掉 ${id}` });
        }
        return json(400, { error: '需要 {"op":"add|select|remove", …}' });
      },
    }
  ];
}
