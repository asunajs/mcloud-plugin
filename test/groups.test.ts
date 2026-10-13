import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, TASK_META, groupView } from '../src/mcloud/groups.ts';
import { memStore } from '../src/store/memory.ts';

test('分组：每条任务的组都存在，且每组都有任务', () => {
  const ids = new Set(GROUPS.map((g) => g.id));
  for (const t of TASK_META) assert.ok(ids.has(t.group), `${t.name} 的组 ${t.group} 不存在`);
  for (const g of GROUPS) assert.ok(TASK_META.some((t) => t.group === g.id), `组 ${g.id} 是空的`);
});

test('分组：任务名不重复', () => {
  const names = TASK_META.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('分组：路线图那两列 —— implemented 说做完了没，evidence 说能不能做', () => {
  const by = (n: string) => TASK_META.find((t) => t.name === n)!;
  // 证据是自愿填的：没填 = 没核对过。填了就必须说得通
  for (const t of TASK_META) {
    if (t.evidence && t.evidence !== 'captured') {
      assert.ok(!t.implemented, `${t.name} 标了已实现，证据却是 ${t.evidence} —— 说不通`);
    }
  }
  // 三处更正（都是查源码查出来的，不是估的）
  assert.equal(by('notice').deps.join(), 'jwt', 'notice 用的是签到页那张票 —— 手里已有');
  assert.equal(by('msg-push').group, 'activity', 'msg-push 要另一张票（msgpushon），不属于 daily');
  assert.equal(by('fun-ai').group, 'activity', 'fun-ai 的票换不出来，不属于 daily');
  assert.equal(by('fun-ai').evidence, 'no-ticket');
});

test('分组视图：带上运行时状态，且不编造面板才知道的东西', () => {
  const store = memStore()   ;
  store.setState('mcloud.last_error.sign', '上游 500');
  const v = groupView(store);
  const sign = v.groups.flatMap((g) => g.tasks).find((t) => t.name === 'sign')!;
  assert.equal(sign.lastError, '上游 500');
  // 只有插件自己知道的东西才是字段；next_run 之类面板才知道，不该出现在这里
  assert.ok(!JSON.stringify(v).includes('next_run'), '不该编造面板侧字段');
  assert.equal(v.totals.tasks, TASK_META.length);
});
