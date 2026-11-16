// push 那一组路由（4 条）：/push/config · /push/rules · /push/bindings · /push/test
//
// 由 mcloudRoutes 组合（见 ../index.ts）。

import { CHANNELS, configuredChannels, sendPush } from '../../../mcloud/push.ts';
import type { PushChannel, PushConfig } from '../../../mcloud/push.ts';
import { loadPushConfig, savePushBindings, savePushConfig, savePushRules } from '../../../mcloud/pushConfig.ts';
import type { PushRule } from '../../../mcloud/pushConfig.ts';
import { json, parseJson } from '../support.ts';
import type { RouteDeps, RouteEntry } from '../support.ts';

/** push 组。deps 是路由依赖；base 是 /plugins/mcloud/api；verify 是「拿当前会话验一次」。 */
export function pushRoutes(deps: RouteDeps, base: string, verify: () => Promise<{ ok: boolean; note: string }>): RouteEntry[] {
  void verify;
  return [
{
      // 存推送配置。
      //
      // # 为什么是**合并**而不是整份覆盖
      //
      // 界面上**拿不到已经存着的值**（读数里只有掩码 —— token 不上屏是硬规则）。
      // 所以界面没法"把整份发回来"，它只知道用户这次改了什么。
      //
      // 但纯合并又做不到"删掉一个渠道"（删了下次会被旧值补回来）——
      // 所以请求体里带一个**显式的 `remove` 列表**：
      //
      //     { "set": { "bark": { "key": "…" } }, "remove": ["pushplus"] }
      //
      // 两种形状都收：给一个裸的配置对象就是"合并这几项"（写脚本时更顺手），
      // 给 `{set, remove}` 就是完整语义。
      path: `${base}/push/config`,
      method: 'POST',
      handler: (req) => {
        const body = parseJson(req.body);
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return json(400, { error: '请求体要是 JSON 对象' });
        }
        const raw = body as Record<string, unknown>;
        // `{set, remove}` 形状 vs 裸配置对象
        const isPatch = raw['set'] !== undefined || raw['remove'] !== undefined;
        const setObj = (isPatch ? raw['set'] : raw) as Record<string, unknown> | undefined;
        const remove = Array.isArray(raw['remove']) ? (raw['remove'] as unknown[]) : [];

        const cur = loadPushConfig(deps.store);
        if (setObj !== undefined && setObj !== null) {
          for (const [k, v] of Object.entries(setObj)) {
            if (k === 'title') {
              cur.title = typeof v === 'string' ? v : undefined;
              continue;
            }
            if (!CHANNELS.includes(k as PushChannel)) continue; // 不认识的键直接丢
            if (v === null) delete (cur as Record<string, unknown>)[k];
            else if (k === 'customPost') cur.customPost = v as PushConfig['customPost'];
            else (cur as Record<string, unknown>)[k] = v;
          }
        }
        for (const k of remove) {
          if (typeof k === 'string' && CHANNELS.includes(k as PushChannel)) {
            delete (cur as Record<string, unknown>)[k];
          }
        }
        savePushConfig(deps.store, cur, deps.now());
        const n = configuredChannels(cur);
        deps.log(`推送配置已保存（配了 ${n.length} 个渠道）`);
        return json(200, { ok: true, configured: n });
      },
    },

{
      // 存推送规则（整份覆盖，同上的理由）。
      path: `${base}/push/rules`,
      method: 'POST',
      handler: (req) => {
        const body = parseJson(req.body);
        if (!Array.isArray(body)) return json(400, { error: '请求体要是数组' });
        // 只收形状对的那些 —— 一条坏规则不该让整份存不进去
        const rules = (body as PushRule[]).filter(
          (r) => r !== null && typeof r === 'object' && typeof r.id === 'string' && r.id !== '',
        );
        savePushRules(deps.store, rules, deps.now());
        deps.log(`推送规则已保存（${rules.length} 条）`);
        return json(200, { ok: true, count: rules.length });
      },
    },

{
      // 存「哪个任务用哪条规则」。
      path: `${base}/push/bindings`,
      method: 'POST',
      handler: (req) => {
        const body = parseJson(req.body);
        if (body === null || typeof body !== 'object') {
          return json(400, { error: '请求体要是 JSON 对象' });
        }
        const src = body as Record<string, unknown>;
        const b = {
          daily: typeof src['daily'] === 'string' ? src['daily'] : '',
          exchange: typeof src['exchange'] === 'string' ? src['exchange'] : '',
          live: typeof src['live'] === 'string' ? src['live'] : '',
        };
        savePushBindings(deps.store, b, deps.now());
        deps.log('推送绑定已保存');
        return json(200, { ok: true, bindings: b });
      },
    },

{
      // **试发一条**。存在的理由：推送最难受的失败方式是"配好了、但收不到"，
      // 而那时用户不知道是配置错了、还是任务没跑、还是根本没到发送那一步。
      // 这个按钮把这三件事分开：它直接发一条，成不成当场告诉你。
      path: `${base}/push/test`,
      method: 'POST',
      handler: async () => {
        const cfg = loadPushConfig(deps.store);
        const chans = configuredChannels(cfg);
        if (chans.length === 0) {
          return json(200, { ok: false, line: '一个渠道都没配', results: [] });
        }
        const r = await sendPush(deps.pushDeps, cfg, '云盘 · 试发', '这是一条试发的推送。\n收到就说明配置对了。');
        deps.log(`试发推送：${r.line}`);
        return json(200, { ok: r.failed === 0 && r.sent > 0, line: r.line, results: r.results });
      },
    }
  ];
}
