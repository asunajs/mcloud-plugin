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

/** 锁内读改写要的**最小**能力（可选 —— 测试替身可以不实现）。
 *
 *  实现方（fileStore）保证"读 → fn → 写"整段在同一把锁里；没有它的实现时，
 *  调用方退回"读出来改一点整份写回去"的旧路 —— 那条路在单进程里是对的，
 *  跨进程会丢更新（见 `store/types.ts::update` 的说明）。 */
export interface UpdatableState extends WritableState {
  update(key: string, fn: (prev: string | null) => string | null, nowIso?: string): void;
}
