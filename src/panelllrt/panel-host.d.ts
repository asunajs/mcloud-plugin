// `panel:host` 是 panel-llrt 宿主注入的模块，**没有类型声明**（面板侧只有文档）。
//
// 这里只给"它存在"这一件事：真正用它的地方（`hostApi.ts`）已经把返回值收成 `any`
// 并按旧契约收窄 —— 所以这份声明保持最松，别在这里编一套看起来精确、实际会骗人的签名。
declare module 'panel:host' {
  const host: Record<string, unknown>;
  export default host;
}
