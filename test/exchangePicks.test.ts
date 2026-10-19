// 「要换什么」这一格：**从清单里选**，不手打（用户 2026-10-17）。
//
// 用户的原话是：「名字不应该自己写，而是缓存一份服务端的数据，然后下拉菜单（可搜索）选，
// 缓存是每天清理一次（如果用户点了该界面的话）」，补一句「允许手动刷新」。
//
// 为什么这事值得测：发回移动云盘的查询串要么**一字不差**是那句名字、要么是个编号
// （`pickPrize`）。手打就是把上游的匹配规则甩给用户背 —— 界面自己都承认过
// 「名字要写完整（「月卡」不会命中「季卡」）」，而承认完还是让人打。
//
// ⚠ 这里全是**静态**判据（读源码找形状）。真正跑通要 DOM，测不了 ——
// 所以每条都盯着"哪个形状一旦改回去，用户就又得手打"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../plugins/mcloud/', import.meta.url);
const html = readFileSync(new URL('index.html', dir), 'utf8');
const js = readFileSync(new URL('app.js', dir), 'utf8');
const css = readFileSync(new URL('style.css', dir), 'utf8');
const srcOf = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const routes = srcOf('src/mcloud/routes.ts');

/** 从某个标记往后截一段（够看清那个处理函数干了什么，不会串到下一条路由）。 */
function handlerOf(marker: string): string {
  const at = routes.indexOf(marker);
  assert.ok(at >= 0, `routes.ts 里找不到「${marker}」`);
  const end = routes.indexOf('\n    },', at);
  return routes.slice(at, end < 0 ? at + 900 : end);
}

const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, '');
/** `app.js` 去掉整行注释 —— 上面那些"不许回来"的断言得看**代码**，
 *  而这一版 app.js 的注释里明写着"这里原来读的是 `e.reading.prizes`"。 */
const jsCode = js.replace(/^\s*\/\/.*$/gm, '');

test('手动兑换不再让用户存目标：清单行直接兑换', () => {
  // 目标保存 / 下拉都删了：手动兑换直接在清单行点「立即兑换」。
  assert.ok(!visibleHtml.includes('id="ex-plan"'), '不该再有隐藏目标格');
  assert.ok(!visibleHtml.includes('id="ex-pick-btn"'), '不该再有奖品下拉');
  assert.ok(!visibleHtml.includes('保存手动目标'), '不该再有保存手动目标');
  assert.ok(/data-buy-idx/.test(js), '清单行仍要有立即兑换');
});

test('⚠ 下拉与「奖品清单」那张表读**同一份**缓存（`picks`）', () => {
  // 原来表格读的是 `e.reading.prizes` —— 而那个读数里**根本没有 `prizes` 这一格**
  // （`readExchangeList` 回的是摘要，可兑的那部分键叫 `ok`）⇒ 表格恒空、
  // 界面永远说"还没有清单读数"，而目标只能手打。这条就是钉住那个死形状。
  assert.ok(/exPicks = \(e\.picks && e\.picks\.items\) \|\| \[\];/.test(js), '下拉与表都要吃 `picks`');
  assert.ok(!/e\.reading\.prizes/.test(jsCode), '`reading.prizes` 不许回来（那个键不存在）');
  assert.ok(!/p\.stock/.test(jsCode), '`stock` 也不许回来（上游没这个字段）');
  // 表格列里有"编号" —— 名字撞车时（会员1天/会员3天）那是唯一分得开的东西
  assert.ok(/<th>奖品<\/th><th>编号<\/th>/.test(js), '表格要有编号那一列');
});

test('⚠ 手动刷新：清单旁一颗「读一次」，后端那条路由**只读清单**', () => {
  assert.ok(/\$\('ex-read'\)/.test(js), '界面没取用 ex-read');
  assert.ok(!/ex-picks-refresh/.test(js), '旧的「刷新清单」入口已删');
  assert.ok(/function refreshPicks\(\)/.test(js), '缺 refreshPicks');
  // 后端：只发清单那一枪。⚠ 不许混进干跑（那会把余额/预热/取题一起打出去），
  // 更不许碰下单。
  const h = handlerOf('/exchange/picks`');
  assert.ok(/runExchangeList\(d\)/.test(h), '这条路由要调 `runExchangeList`');
  for (const bad of ['runExchange(', 'clearOrder', 'runOrderStep', 'solveSlide', 'beans']) {
    assert.ok(!h.includes(bad), `只读清单的路由里出现了「${bad}」—— 那就不止一枪了`);
  }
});

test('点开这一屏会**自动补一枪**；票新且有缓存才跳过，票过期则无感续票重读', () => {
  // 判据有两层：① 今天这份缓存有没有；② 两小时那张票还新不新。
  // 票过期时不能把"50 件全判不了"甩给用户 —— 先续票再重读（参考 mcloud 的 H5Client）。
  assert.ok(/function autoFetchPicksOnce\(\)/.test(js), '缺 autoFetchPicksOnce');
  assert.ok(/if \(exPicksAutoFetched\) return;/.test(js), '只补一次');
  // 用户口径（2026-10-18）：两小时那张票过期要**无感续**，不是让用户点。
  // 所以"有缓存"不再单独构成跳过条件：票过期时自动续票并重读。
  assert.ok(/const jwtExpired = !!\(cur && cur\.jwtExpired\);/.test(js), '要看票过没过期');
  assert.ok(/if \(have && !jwtExpired\) return;/.test(js), '票新且有缓存才不打');
  assert.ok(/await ensureH5Session\(\)/.test(js), '续票是无感的');
  assert.ok(/if \(name === 'exchange'\) autoFetchPicksOnce\(\);/.test(js), '挂在"点开这一屏"上');
  // ⚠ 不挂定时器（用户说的是"如果用户点了该界面的话"）
  assert.ok(!/setInterval\([^)]*autoFetchPicksOnce/.test(js), '不许挂定时器去自动刷清单');
});

test('⚠ 存目标要**同时**写「用户要换的那句」与「这一单在排队」—— 少一格定时链永远不动', () => {
  // 2026-10-17 mock 实测到的真缺陷：`/exchange/order` 原来只调 `startOrder`，
  // 而它写的是 `mcloud.exchange.order.plan`（这一单的）；定时链读的是
  // `mcloud.exchange.plan`（`exchangeRun.ts` 的 `PLAN_KEY`）⇒ 界面上存住了、
  // 那一格恒空 ⇒ 每次触发都回「没有设兑换目标」，**选谁都抢不到**。
  const h = handlerOf('/exchange/order`');
  assert.ok(
    /deps\.store\.setState\('mcloud\.exchange\.plan', query, d\.nowIso\)/.test(h),
    '没写 `mcloud.exchange.plan` ⇒ 定时链读不到目标',
  );
  assert.ok(/startOrder\(d, query\)/.test(h), '排队那一半也得留着（逐步推进读它）');
  // 空值不许把已存的目标抹了（界面那边另有"空就不发"的挡，这里是后端那道闸）
  assert.ok(/if \(query !== ''\) deps\.store\.setState\(/.test(h), '空查询该只失败、不清目标');
});

test('⚠ 缓存是**账号级**的，且"每天清一次"发生在读的时候（本地写一格，不打上游）', () => {
  const keys = srcOf('src/store/keys.ts');
  assert.ok(/'mcloud\.exchangelist\.pick': 'account'/.test(keys), '这一格必须按账号存（每个号清单不同）');
  // 读视图时顺手判过期：点开这一屏就是"今天第一次看"
  assert.ok(/picks: readPickCache\(deps\.store, nowIso\)/.test(routes), '区块视图要把缓存带出去（并在此处作废）');
  const list = srcOf('src/mcloud/tasks/exchangeList.ts');
  assert.ok(/if \(c === null \|\| c\.date !== today\)/.test(list), '过期判据要在读缓存里');
  assert.ok(/store\.setState\(STATE_PICK, '', nowIso\)/.test(list), '过期要**就地写空**，不是留着每次判');
});

test('兑换页对齐原页面：关注 / 分组 / 二次确认 / 本地判定 / 立即兑换', () => {
  for (const id of ['ex-subs', 'ex-confirm-first', 'ex-local-judge', 'ex-filter', 'ex-verdict', 'ex-result', 'ex-account']) {
    assert.ok(html.includes(`id="${id}"`), `缺 ${id}`);
  }
  assert.ok(/function renderExchangeSubs\(/.test(js), '缺关注区');
  assert.ok(/function renderExchangeTable\(/.test(js), '缺分组清单');
  assert.ok(/function exBuyNow\(/.test(js), '缺立即兑换');
  assert.ok(/api\('\/exchange\/subs', \{/.test(js), '关注要走订阅路由');
  assert.ok(/data-label="奖品"/.test(js), '窄屏卡片需要字段名');
  assert.ok(/ex-group-row/.test(js) && /ex-group-row/.test(css), '分组头要样式');
  // 组名用上游组字典里的具体名称，不再显示「第 N 组」。
  assert.ok(/EX_GROUP_TITLES/.test(js) && /视频类会员/.test(js), '组名要具体名称');
  assert.ok(!/第 \$\{key\} 组/.test(js), '不要再回退成「第 N 组」');
  // 组头可点，且默认全部折叠；点开状态记在 exOpenGroups 里。
  assert.ok(/data-group-toggle/.test(js), '组头要可点击');
  assert.ok(/exOpenGroups/.test(js) && /open \? '' : ' hidden'/.test(js), '默认折叠，点开才显示');
  assert.ok(/path: `\$\{base\}\/exchange\/subs`/.test(routes), '后端要有订阅路由');
  assert.ok(/readSubscriptions\(deps\.store\)/.test(routes), '读数里要带关注');
  // 数字输入改成「− 数字 +」整条胶囊步进器。
  assert.ok(/data-step-for="ex-plan-lead-sec"/.test(html) && /data-step-for="ex-plan-lead"/.test(html), '数字框要有左右加减');
  assert.ok(/\.stepper-input/.test(css) && /flex: 1/.test(css), '步进器输入要撑满胶囊中间');
  // 手动兑换与定时抢兑拆开：定时有独立弹窗与独立目标，不覆盖手动目标。
  for (const id of ['ex-plan-dialog', 'ex-plan-cron', 'ex-plan-lead-sec', 'ex-plan-submit']) {
    assert.ok(html.includes(`id="${id}"`), `缺定时弹窗的 ${id}`);
  }
  assert.ok(/api\('\/exchange\/plans'/.test(js), '定时保存走计划表，不起单');
  assert.ok(/action: 'save'/.test(js), '计划保存动作是 save');
  // 多计划：入口按目标整点分发，每条计划只跑自己的账号。
  const entry = srcOf('src/entries/exchange.ts');
  const run = srcOf('src/mcloud/tasks/exchangeRun.ts');
  assert.ok(/duePlans\(loadPlans\(store\)/.test(entry), '入口要按计划分发');
  assert.ok(/depsForAccount\(store, plan\.accountId/.test(entry), '每条计划一个账号的 deps');
  assert.ok(
    /scopedAccountOf\(deps\.store\)/.test(run) && /a\.id === scopedId/.test(run),
    'runExchange 要按 scoped 账号过滤（否则每条计划会跑全部账号）',
  );
  assert.ok(/schedulePlan/.test(routes) && /STATE_SCHEDULE_PLAN/.test(routes), '读数要带定时目标');
});
