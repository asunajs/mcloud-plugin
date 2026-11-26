// 云盘活动面（从 cmcc-plugin 迁来）：端点清单与摘要格式（纯函数）。
//
// 2026-11-26 迁移时实测：5 个端点全 code=0；另有 6 个已下线（404/500）。
// 这里钉住两件事：① 清单里只有能用的只读端点；② 已下线的不能悄悄回来。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_ACT_ENDPOINTS,
  CLOUD_ACT_GONE,
  actSummaryLine,
} from '../src/mcloud/tasks/cloudActs.ts';

test('清单里只有只读端点（GET 语义，不含写动作）', () => {
  assert.ok(CLOUD_ACT_ENDPOINTS.length >= 5);
  for (const ep of CLOUD_ACT_ENDPOINTS) {
    assert.match(ep.path, /^\/ycloud\//, '路径应在 /ycloud/ 下：' + ep.path);
    const action = ep.path.split('/').filter((x) => x !== '').pop() ?? '';
    for (const bad of ['execute', 'lottery', 'receive', 'claim', 'submit', 'draw']) {
      assert.ok(
        !new RegExp(bad, 'i').test(action),
        '活动面清单里不该有写操作：' + ep.path,
      );
    }
  }
});

test('已下线的端点不许混进可用清单', () => {
  const live = new Set(CLOUD_ACT_ENDPOINTS.map((e) => e.path));
  for (const gone of CLOUD_ACT_GONE) {
    assert.ok(!live.has(gone), '已下线的端点又回到清单里了：' + gone);
  }
});

test('actSummaryLine：数组报项数', () => {
  assert.equal(actSummaryLine('许愿奖品列表', [{}, {}]), '许愿奖品列表：2 项');
  assert.equal(actSummaryLine('许愿奖品列表', []), '许愿奖品列表：0 项');
});

test('actSummaryLine：推送任务状态报 total', () => {
  assert.equal(actSummaryLine('推送任务状态', { total: 31 }), '推送任务状态：共 31 项');
});

test('actSummaryLine：美图次数报四个计数', () => {
  assert.equal(
    actSummaryLine('美图备份次数', {
      authTotalCount: 1,
      authDailyCount: 1,
      backupTotalCount: 1,
      backupDailyCount: 1,
    }),
    '美图备份次数：授权 1（今日 1）/ 备份 1（今日 1）',
  );
});

test('actSummaryLine：AI通讯额度', () => {
  assert.equal(
    actSummaryLine('AI通讯邀请', { qoutaCnt: '0.00', prizeCnt: '0' }),
    'AI通讯邀请：额度 0.00，奖品 0',
  );
});

test('actSummaryLine：null / 空对象 / 标量都要能出人话', () => {
  assert.equal(actSummaryLine('x', null), 'x：无数据');
  assert.equal(actSummaryLine('x', {}), 'x：空对象');
  assert.equal(actSummaryLine('x', 42), 'x：42');
});