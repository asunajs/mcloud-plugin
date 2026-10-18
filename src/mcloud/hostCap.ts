// 宿主能不能用 `tls:"native"` —— 也就是**这个面板构建支不支持直播**。
//
// # 为什么要有这个文件
//
// 直播那条链（换直播侧 JWT、连弹幕 WS）必须用 `tls:"native"`：上游
// `v.cmcc-cs.cn` / `videoim.cmcc-cs.cn:20102` 只给 CBC 套件，而 rustls 一个 CBC
// 都不实现。`tls:"native"` 又要宿主用 `--features legacy-tls` 编 —— 默认关闭。
//
// 于是"面板是拿什么编的"这件事，直接决定直播能不能用。以前它只表现为**跑起来之后**
// 一条长警告：
//
// ```
// ② 换直播侧 JWT 失败：tls:"native" 需要宿主用 `--features legacy-tls` 构建
// （本构建里只有 rustls；那条路会在 Linux 上引入 OpenSSL 依赖，所以默认不编）（继续试一次）
// ```
//
// 那句话对用户是**噪音**：他既改不了宿主怎么编，也不该从一句 TLS 报错里反推
// "我这个版本没有直播"。所以这里把答案**提前问一次**并记住：
// 支持 ⇒ 什么都不说；不支持 ⇒ 说一句人话，然后**别再去试**。

import type { Transport } from './client.ts';
import { isFetchError } from './client.ts';
import type { Store } from '../store/types.ts';

/** 探测结论存哪（按账号的袋里 —— 这个结论其实与账号无关，但按账号存最省事）。 */
export const STATE_CAP = 'mcloud.host.native_tls';

/** 多久重探一次。
 *
 *  ⚠ 不能永久缓存：面板**换一个二进制重启**之后能力就变了（重编一次就没 feature 了），
 *  而插件状态是跨重启留在 SQLite 里的。一小时是个折中 —— 真换了构建，最多晚一小时纠正；
 *  探测本身是一个发往 `127.0.0.1:9` 的请求，一次就够。
 */
export const CAP_TTL_MS = 60 * 60 * 1000;

export type CapVerdict = 'yes' | 'no';

interface Cached {
  at: string;
  verdict: CapVerdict;
  /** 上游/宿主原话（只在"不支持"时有用，给排障看）。 */
  why: string;
}

/** 探测：发一枪**一定连不上**的请求，但用的是 `tls:"native"`。
 *
 *  为什么这样判：宿主的 `parse_tls_choice` 是**先校验选项、再发请求** ——
 *  没有那个 feature 时，它在发请求之前就回
 *  `tls:"native" 需要宿主用 --features legacy-tls 构建`。
 *  所以"错误里提到 legacy-tls" = 不支持；**别的错误**（连接被拒、超时）=
 *  选项通过了、只是站点不存在 ⇒ 支持。 */
export function probeNativeTls(transport: Transport): { verdict: CapVerdict; why: string } {
  const r = transport({
    url: 'https://127.0.0.1:9/',
    method: 'GET',
    headers: {},
    body: undefined,
    tls: 'native',
  });
  if (isFetchError(r)) {
    const msg = r.error ?? '';
    return { verdict: /legacy-tls/.test(msg) ? 'no' : 'yes', why: msg };
  }
  // 真连通了（不该发生）⇒ 显然支持
  return { verdict: 'yes', why: '' };
}

/** 拿结论：缓存新鲜就用缓存，否则重探。 */
export function hostNativeTls(
  store: Pick<Store, 'getState' | 'setState'>,
  nowIso: string,
  transport: Transport,
): { verdict: CapVerdict; why: string; fresh: boolean } {
  const raw = store.getState(STATE_CAP);
  if (raw !== null && raw !== '') {
    try {
      const c = JSON.parse(raw) as Cached;
      const at = Date.parse(c.at);
      const now = Date.parse(nowIso);
      if (
        (c.verdict === 'yes' || c.verdict === 'no') &&
        Number.isFinite(at) &&
        Number.isFinite(now) &&
        now - at < CAP_TTL_MS
      ) {
        return { verdict: c.verdict, why: typeof c.why === 'string' ? c.why : '', fresh: true };
      }
    } catch {
      /* 坏了就重探 */
    }
  }
  const p = probeNativeTls(transport);
  const v: Cached = { at: nowIso, verdict: p.verdict, why: p.why };
  store.setState(STATE_CAP, JSON.stringify(v), nowIso);
  return { ...p, fresh: false };
}

/** 探测到"不支持"时说的话。
 *
 *  ⚠ 措辞是**故障**，不是"一种配置"：
 *  直播要的那条 TLS 路（`legacy-tls`）从 2026-10-17 起就是**默认编进去的** ——
 *  正常发布的面板不会有这个状态。出现了只有一种解释：**这个二进制编漏了**。
 *  所以这里不能写"换一个支持的构建就好"（那像是在说"你选错了版本"），
 *  而要说清"这是个缺陷，去换/去重编"，并且用 error 级别让它显眼。 */
export function capNote(verdict: CapVerdict): string {
  return verdict === 'yes'
    ? ''
    : '这个面板二进制缺直播要的 TLS 支持（构建漏了 `legacy-tls`，它本该是默认带的）—— 这是构建缺陷，不是配置问题；换一个正常的面板构建。';
}
