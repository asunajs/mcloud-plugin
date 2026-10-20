// 独立运行的运行时：配置 → 账号表 → 文件状态 → curl/ws 传输。
//
// 任务逻辑本身不 import 这里；它只拿 TaskDeps。这样面板与独立入口共用同一批任务。

import { loadAccounts, saveAccounts, phoneOf, upsertAccount, type Account } from '../mcloud/accounts.ts';
import { STATE_CURRENT_ACCOUNT } from '../store/keys.ts';
import { scoped } from '../store/scoped.ts';
import type { Store } from '../store/types.ts';
import { taskDeps } from '../mcloud/accountRuntime.ts';
import type { HostWs, TaskDeps } from '../mcloud/tasks/base.ts';
import { applyDefaultContentType, type Transport } from '../mcloud/client.ts';
import type { ListenDeps } from '../mcloud/tasks/liveListen.ts';
import { loadConfig, type StandaloneConfig } from './config.ts';
import { FileStore } from './fileStore.ts';
import { makeNodeFetcher } from './httpBridge.ts';
import { installFetcher, installWs } from './hostApi.ts';
import { makeWsBridge, type WsBridge } from './wsBridge.ts';

export interface Runtime {
  readonly config: StandaloneConfig;
  readonly rawStore: Store;
  readonly store: Store;
  readonly transport: Transport;
  readonly nowIso: string;
  /** 某个账号的 TaskDeps（不包含 host；直播编排自己加）。 */
  depsFor(acctId?: string): TaskDeps;
  /** 直播编排要的 deps（带 ws host）。 */
  listenDepsFor(acctId?: string): ListenDeps;
  close(): void;
}

function seedAccounts(raw: Store, config: StandaloneConfig): void {
  const nowIso = new Date().toISOString();
  const existing = loadAccounts(raw);
  const next: Account[] = [];
  const used = new Set<string>();
  for (const [index, seed] of config.accounts.entries()) {
    const phone = phoneOf(seed.auth);
    const hit =
      existing.find((a) => (phone !== undefined && phoneOf(a.auth) === phone) || a.auth === seed.auth) ??
      // 没有手机号可比时按配置顺序对齐：旧版配置只给 auth/nickname，换票后的
      // auth 可能完全认不出手机号，但账号顺序仍然是稳定的。
      existing.find((a, i) => i === index && !used.has(a.id)) ??
      undefined;
    const label = seed.label ?? seed.nickname ?? hit?.label ?? phone ?? '账号';
    if (hit !== undefined) {
      if (used.has(hit.id)) continue;
      used.add(hit.id);
      next.push({
        ...hit,
        label,
        auth: seed.replaceAuth === true || hit.auth === '' ? seed.auth : hit.auth,
        disabled: seed.disabled === true,
      });
      continue;
    }
    // 新号：走 upsertAccount，id/平台/手机号规则与面板一致
    const { account } = upsertAccount(raw, seed.auth, nowIso, label);
    if (account.id === '') continue;
    if (used.has(account.id)) continue;
    used.add(account.id);
    next.push({ ...account, label, disabled: seed.disabled === true });
  }
  saveAccounts(raw, next, nowIso);
  if (next.length > 0 && (raw.getState(STATE_CURRENT_ACCOUNT) ?? '') === '') {
    raw.setState(STATE_CURRENT_ACCOUNT, next[0]!.id, nowIso);
  }
}

export async function createRuntime(opts: { configPath?: string; stateFile?: string } = {}): Promise<Runtime> {
  const config = await loadConfig(opts.configPath);
  const stateFile = opts.stateFile ?? config.stateFile;
  const rawStore = new FileStore(stateFile, new Date().toISOString());
  try {
    seedAccounts(rawStore, config);
  } catch (e) {
    rawStore.close();
    throw e;
  }

  const fetcher = makeNodeFetcher(config.http);
  installFetcher(fetcher);
  const transport: Transport = (req) => {
    const r = applyDefaultContentType(req);
    return fetcher(r.url, {
      method: r.method,
      headers: r.headers,
      body: r.body,
      timeout_ms: config.http.timeoutMs,
    });
  };

  let wsBridge: WsBridge | undefined;
  const ws = (): WsBridge => {
    wsBridge ??= makeWsBridge(config.ws);
    return wsBridge;
  };
  const host: HostWs = {
    wsOpen: (url, o) => ws().open(url, o),
    wsSend: (id, text) => ws().send(id, text),
    wsRecv: (id, timeoutMs) => ws().recv(id, timeoutMs),
    wsClose: (id) => ws().close(id),
  };
  installWs({
    open: (url, o) => host.wsOpen(url, o),
    send: (id, text) => host.wsSend(id, text),
    recv: (id, timeoutMs) => host.wsRecv(id, timeoutMs),
    close: (id) => host.wsClose(id),
  });

  const scopedStore = scoped(rawStore);
  const runtime: Runtime = {
    config,
    rawStore,
    store: scopedStore,
    transport,
    nowIso: new Date().toISOString(),
    depsFor(acctId?: string) {
      const one = acctId === undefined ? scopedStore : scoped(rawStore, acctId);
      return taskDeps(one, transport, { lateMs: 0 });
    },
    listenDepsFor(acctId?: string): ListenDeps {
      return { ...runtime.depsFor(acctId), host };
    },
    close() {
      wsBridge?.dispose();
      rawStore.close();
    },
  };
  return runtime;
}
