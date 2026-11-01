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
  // 已实现的必须有证据，而且不能是"做不了"的那两档。
  //
  // 这条规则改过一次：原来写的是"证据不是 captured 就不许标已实现"——
  // 太粗了。`partial`（只实拍到成功那一枪、失败形态零样本）**是能实现的**，
  // 前提是把缺口写清楚：`notice` 就是这一档。真正做不了的是
  // `none`（零样本）与 `no-ticket`（连票怎么换都不知道）。
  for (const t of TASK_META) {
    if (!t.implemented) continue;
    // 插件自己的任务（自检 / 调度健康 / 会话体检）没有"上游证据"这回事 ——
    // 这一列说的是**上游**能不能照实写，它们不跟上游打交道。
    if (t.group === 'plugin') continue;
    assert.ok(t.evidence, `${t.name} 标了已实现却没写证据`);
    assert.notEqual(t.evidence, 'none', `${t.name} 零样本却标了已实现`);
    assert.notEqual(t.evidence, 'no-ticket', `${t.name} 连票都换不出来却标了已实现`);
  }
  // 三处更正（都是查源码查出来的，不是估的）
  assert.equal(by('notice').deps.join(), 'jwt', 'notice 用的是签到页那张票 —— 手里已有');
  assert.equal(by('msg-push').group, 'activity', 'msg-push 要另一张票（msgpushon），不属于 daily');
  assert.equal(by('fun-ai').group, 'activity', 'fun-ai 的票换不出来，不属于 daily');
  assert.equal(by('fun-ai').evidence, 'no-ticket');
  // ⚠ 2026-10-23 新增的一档：`ran-elsewhere` = **本仓库零抓包**，但参照实现在真账号上
  // 跑成功过、**逐行产出留了档**。它不在"做不了"那两档里（所以标已实现是合法的），
  // 但它**不等于** `captured`：端点与字段名没在我们这一侧复验过，
  // 上游改形状时不会响 —— 所以这一档必须同时在 note 里写清"靠什么跑通的"。
  const rp = by('cloud-phone-redpack');
  assert.equal(rp.implemented, true, '红包派对已接（逐行文案照参照实现）');
  assert.equal(rp.evidence, 'ran-elsewhere', '这一族的读数来自别人那一次运行，不是我们的抓包');
  assert.ok(rp.note !== undefined && rp.note.includes('零抓包'), '标了 ran-elsewhere 就要在 note 里说清证据从哪来');
  // 装机那条会往**用户的云机里装包** —— 风险档不能停在"记账"
  assert.equal(rp.risk, 'write-cloud', 'MONTHLY_2 会往云机装 APK');
});

test('分组视图：带上运行时状态，且不编造面板才知道的东西', () => {
  const store = memStore();
  store.setState('mcloud.last_error.sign', '上游 500', '2026-10-13T20:00:00Z');
  const v = groupView(store);
  const sign = v.groups.flatMap((g) => g.tasks).find((t) => t.name === 'sign')!;
  assert.equal(sign.lastError, '上游 500');
  // 只有插件自己知道的东西才是字段；next_run 之类面板才知道，不该出现在这里
  assert.ok(!JSON.stringify(v).includes('next_run'), '不该编造面板侧字段');
  assert.equal(v.totals.tasks, TASK_META.length);
});
