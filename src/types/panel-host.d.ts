// `panel:host` 是面板引擎注入的模块，**没有官方类型**（面板侧只有文档）。
//
// 这里只声明"它存在"：真正的形状翻译在 `src/host/panel/impl.ts` 一处完成，
// 并且已经按面板的 `docs/host-api.md` 收窄过。**别在这里编一套看起来精确、
// 实际会骗人的签名** —— 那比 any 更危险（F-006 就是这么来的）。
declare module 'panel:host' {
  const host: Record<string, unknown>;
  export default host;
}
