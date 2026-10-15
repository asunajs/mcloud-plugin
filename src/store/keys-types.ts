// `readKey`/`writeKey` 要的**最小**存储能力。
//
// ⚠ 故意比 `Pick<Store, 'getState'>` 更宽：很多调用点手里只有个窄接口
// （测试替身、`{ getState }` 这种），而读键确实只需要"能读"。
// 写成 `Store` 会逼调用点去造一个假 Store —— 那是给测试加噪声，不是加约束。
//
// 单独一个文件是为了**避免循环依赖**：`keys.ts` 需要这两个类型，
// 而 `types.ts` 需要 `readKey`/`writeKey`（会话那层）。类型放中间，
// 两边都只依赖它，谁也不依赖谁。

export interface ReadableState {
  getState(key: string): string | null | undefined;
}

export interface WritableState extends ReadableState {
  setState(key: string, value: string, nowIso: string): void;
}
