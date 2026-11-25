// 独立运行的运行时：配置 → 账号表 → 文件状态 → curl/ws 传输。
//
// 任务逻辑本身不 import 这里；它只拿 TaskDeps。这样面板与独立入口共用同一批任务。

import { STATE_CURRENT_ACCOUNT } from '../store/keys.ts';
import { scoped } from '../store/scoped.ts';
import type { Store } from '../store/types.ts';
import { taskDeps } from '../mcloud/accountRuntime.ts';
import type { HostWs, TaskDeps } from '../mcloud/tasks/base.ts';
import { applyDefaultContentType, type Transport } from '../mcloud/client.ts';
import type { PkDrawConfig } from '../mcloud/tokenPkState.ts';
import type { ListenDeps } from '../mcloud/tasks/liveListen.ts';
import { dirname } from 'node:path';
import { loadConfig, type StandaloneConfig } from './config.ts';
import { openFileStore } from '../host/fs/fileStore.ts';
import { migrateUserConfig } from '../host/fs/configMigrate.ts';
import { importLegacyStateFile } from '../host/fs/importLegacy.ts';
import { makeNodeFetcher } from './httpBridge.ts';
import { debug, installFetcher, installWs } from './hostApi.ts';
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

/** 把配置里的账号种进 store（面板/CLI 同一套 id 与平台规则）。
 *
 *  ⚠ `config.accounts` 为空时**不要调**它：它会把账号表整份替换成空 —— 统一配置模式下
 *  账号本来就不在配置里（在 `shared.json`），那种情况跳过是唯一正确的做法。 */
// `seedAccounts` 搬到业务层了（`mcloud/legacyImport.ts`）：面板的「导入旧配置」也要用它，
// 而那个文件顶层 import 了 `node:fs`/`node:path`，沙箱里一 import 就炸。
// 这里只 re-export，老的调用点（`configImport.ts` / 测试）一行不用改。
import { seedAccounts } from '../mcloud/legacyImport.ts';

export { seedAccounts };

export async function createRuntime(opts: { configPath?: string; stateFile?: string } = {}): Promise<Runtime> {
  const config = await await loadConfig(opts.configPath);
  const stateFile = opts.stateFile ?? config.stateFile;
  // 与面板**同一份实现、同一个目录布局**：CLI 指到面板那个目录就是同一份账号与凭据
  //
  // 统一配置模式（`--config …/config.json`）下目录**就是配置文件所在目录** ——
  // 那份 config.json 和 shared.json 是同一套存储的两个文件，分开指没有意义。
  const storeDir = config.unified ? dirname(config.path) : dirname(stateFile);
  const rawStore = openFileStore({
    dir: storeDir,
    plugin: 'cli',
    nowIso: new Date().toISOString(),
    legacy: () => importLegacyStateFile(storeDir, stateFile),
  });
  rawStore.ensureSchema();
  if (config.unified) {
    // 统一配置模式：配置里**没有**账号（账号是运行期状态，见 docs/architecture.md §3）。
    // 这里只做一次用户配置迁移，账号完全交给这份目录里的 `shared.json`。
    migrateUserConfig(rawStore, new Date().toISOString());
  } else if (config.accounts.length > 0) {
    seedAccounts(rawStore, config);
  }

  const fetcher = makeNodeFetcher(config.http);
  installFetcher(fetcher);
  const transport: Transport = async (req) => {
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
      return {
        ...runtime.depsFor(acctId),
        host,
        // 照 mcloud-sign 的 `[WS] 弹幕: ...`：用户要看到“到底听到了什么”。
        // 换行在 liveListen 里已经折成 `\n`，这里只管打。
        onDanmaku: (text) => debug(`[WS] 弹幕: ${text}`),
      };
    },
    close() {
      wsBridge?.dispose();
      // 文件存储没有"长期持有"的锁（每次写一小会儿），这里不需要释放什么
    },
  };
  return runtime;
}
