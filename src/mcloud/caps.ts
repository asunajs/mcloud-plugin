// 沙箱**能力探测** —— 这个环境到底有什么，而不是"我以为有什么"。
//
// 为什么要单独一个模块：它同时被两处用 —— 自检（`main.ts`）与接口（`/api/caps`）。
// 而"自检跑在 5 分钟一跳的 cron 里"意味着：**你打开面板时多半看不到它**，
// 于是"这个环境支持不支持 BigInt"这种问题就得靠翻日志。
// 接口那一条路让它可以随时问。
//
// ⚠ 这里探测的每一项都**不是"对不对"，是"有没有"** —— 所以它们**不判失败**，
// 只报告。但它们决定**后面几条链能不能做**：
//
//  · `BigInt`     —— smid 那条链要 RSA-2048 PKCS#1 v1.5。没有 BigInt 就得手写大数
//                    模幂（几百行、极易写错），那是另一件事而不是同一条路。
//  · `DataView`   —— DES / AES 按 32 位字做轮函数；没有它只能按字节硬凑。
//  · 大数组 apply —— base64 / gzip 要把几十 KB 一次性交给 `String.fromCharCode`。
//                    这一步会**静默栈溢出**（引擎的实参上限），表现是
//                    "某个长响应偶尔解不开" —— 所以现在探一次，别等它随机出现。

/** 探测一次沙箱能力，返回一行人话。**纯本地计算，不发请求。** */
export function sandboxCaps(): string {
  const g = globalThis as unknown as Record<string, unknown>;

  // 十万个字符一次 apply：既探"有没有"也探"够不够大"
  let applyOk = 'ok';
  try {
    String.fromCharCode.apply(null, new Array(100_000).fill(65) as unknown as number[]);
  } catch (e) {
    applyOk = e instanceof Error ? `抛(${e.constructor.name})` : '抛';
  }

  return [
    `BigInt=${typeof g.BigInt}`,
    `DataView=${typeof g.DataView}`,
    `10万字符apply=${applyOk}`,
  ].join(' ');
}

/** `BigInt` 能不能用 —— 决定 RSA 那条路走"现成的大数"还是"手写模幂"。 */
export function hasBigInt(): boolean {
  return typeof (globalThis as unknown as Record<string, unknown>).BigInt === 'function';
}
