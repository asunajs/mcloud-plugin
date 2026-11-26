// 移动云盘「活动面」只读扫描：许愿 / 奖品 / 推送任务 / 美图备份 / AI通讯邀请。
//
// # 来源
//
// 从 `cmcc-plugin` 的 `mcloudActs.ts` 迁来（2026-11-26 实测 5/5 端点全部 `code=0`）。
// 迁的理由：这 5 个端点 `mcloud-plugin` 一个都没有，而它们本来就属于云盘。
//
// # 端点（全部 GET、只读）
//
// ```text
//   /ycloud/makewish/page/home          许愿活动主页（配置/期次/公布时间）
//   /ycloud/makewish/prize/list         许愿奖品列表
//   /ycloud/msgPushOn/task/status       推送任务状态（total 是任务数）
//   /ycloud/meitu/new/prizeCount        美图备份次数（授权/备份 × 总/今日）
//   /ycloud/aitongxun/invite/user/info  AI通讯邀请（额度/奖品/邀请数）
// ```
//
// # 已知**已下线**的（别再加回来，2026-11-26 实测 404/500）
//
// ```text
//   /ycloud/bill/toDoTask/taskInfos         404
//   /ycloud/luckybag/bag/config/list        404
//   /ycloud/bill/taskLottery/queryCount     404
//   /ycloud/luckybag/common/user/info       404
//   /ycloud/bill/taskLottery/getMyPrizeList 404
//   /ycloud/simple/yunpanli/prize/status    500
// ```
//
// # 只读
//
// 全 GET，没有写口。领奖/抽奖那些另做，别混进来。

import { callRawText } from '../client.ts';
import { buildH5Request, SHOW_LOADING } from '../h5.ts';
import { BASE_MCLOUD, H5_SALT_KEY } from '../h5session.ts';
import { loadSession } from '../../store/types.ts';
import { loadJwt } from '../sessionExchange.ts';
import type { TaskDeps, TaskOutcome } from './base.ts';

/** 活动面 referer（与参考实现同一个页面）。 */
export const CLOUD_ACT_REFERER =
  'https://m.mcloud.139.com/portal/hcyview/index.html?path=National_AnnualRewarding';

export interface CloudActEndpoint {
  label: string;
  path: string;
}

/** 只登记**上游仍在服务**的只读端点。 */
export const CLOUD_ACT_ENDPOINTS: CloudActEndpoint[] = [
  { label: '许愿活动主页', path: '/ycloud/makewish/page/home' },
  { label: '许愿奖品列表', path: '/ycloud/makewish/prize/list' },
  { label: '推送任务状态', path: '/ycloud/msgPushOn/task/status' },
  { label: '美图备份次数', path: '/ycloud/meitu/new/prizeCount' },
  { label: 'AI通讯邀请', path: '/ycloud/aitongxun/invite/user/info' },
];

/** 已知已下线的端点（留档，防有人加回来）。 */
export const CLOUD_ACT_GONE: string[] = [
  '/ycloud/bill/toDoTask/taskInfos',
  '/ycloud/luckybag/bag/config/list',
  '/ycloud/bill/taskLottery/queryCount',
  '/ycloud/luckybag/common/user/info',
  '/ycloud/bill/taskLottery/getMyPrizeList',
  '/ycloud/simple/yunpanli/prize/status',
];

/** 把一个端点的 result 压成一行。纯函数，好单测。 */
export function actSummaryLine(label: string, result: unknown): string {
  if (result === null || result === undefined) return label + '：无数据';
  if (Array.isArray(result)) return label + '：' + String(result.length) + ' 项';
  if (typeof result === 'object') {
    const d = result as Record<string, unknown>;
    if (typeof d['total'] === 'number') return label + '：共 ' + String(d['total']) + ' 项';
    if (typeof d['authTotalCount'] === 'number') {
      return (
        label +
        '：授权 ' +
        String(d['authTotalCount']) +
        '（今日 ' +
        String(d['authDailyCount'] ?? '?') +
        '）/ 备份 ' +
        String(d['backupTotalCount']) +
        '（今日 ' +
        String(d['backupDailyCount'] ?? '?') +
        '）'
      );
    }
    if (typeof d['qoutaCnt'] === 'string') {
      return label + '：额度 ' + d['qoutaCnt'] + '，奖品 ' + String(d['prizeCnt'] ?? '?');
    }
    if (d['config'] !== undefined) return label + '：有活动配置';
    const keys = Object.keys(d);
    return label + '：' + (keys.length === 0 ? '空对象' : keys.slice(0, 4).join(', '));
  }
  return label + '：' + String(result).slice(0, 40);
}

/** 跑一次活动面扫描（只读）。 */
export async function runCloudActs(deps: TaskDeps): Promise<TaskOutcome> {
  const sess = loadSession(deps.store);
  if (sess === null) return { ok: false, note: '没有 H5 会话（先登录一次）' };
  const rec = loadJwt(deps.store);
  if (rec === null || rec.jwt === '') return { ok: false, note: '没有 jwttoken（先换票）' };
  const session = { jwt: rec.jwt, cookie: sess.cookie, userAgent: sess.userAgent };

  const lines: string[] = [];
  let okCount = 0;
  for (const ep of CLOUD_ACT_ENDPOINTS) {
    const req = buildH5Request({
      url: BASE_MCLOUD + ep.path,
      method: 'GET',
      referer: CLOUD_ACT_REFERER,
      showLoading: SHOW_LOADING,
      isDeviceId: false,
      saltKey: H5_SALT_KEY,
      session,
    });
    const r = await callRawText(deps.transport, req);
    if (!r.ok) {
      lines.push(ep.label + '：请求失败');
      continue;
    }
    let j: { code?: unknown; result?: unknown } | null = null;
    try {
      j = JSON.parse(r.text) as { code?: unknown; result?: unknown };
    } catch {
      lines.push(ep.label + '：响应非 JSON');
      continue;
    }
    const code = String(j?.code ?? '?');
    if (code === '0') {
      okCount += 1;
      lines.push(actSummaryLine(ep.label, j?.result));
    } else {
      lines.push(ep.label + '：' + code);
    }
  }
  return {
    ok: okCount > 0,
    note:
      okCount === 0
        ? '活动面全部失败'
        : lines.join('；') + '（' + String(okCount) + '/' + String(CLOUD_ACT_ENDPOINTS.length) + '）',
  };
}