// 长连接端口。**只有听弹幕那一支要它** —— 所以单独一个文件，
// 而不是塞进 TaskDeps（塞进去等于"所有任务都隐含要求宿主支持 WS"）。
//
// 返回形状与面板的 `ws_recv` 一致：**超时是结果不是异常**（一次调用推进一步）。

export type { WsFrame } from './io.ts';

import type { WsFrame } from './io.ts';

export interface HostWs {
  wsOpen(
    url: string,
    opts: { headers?: Record<string, string>; timeout_ms?: number; tls?: 'rustls' | 'native' },
  ): number;
  wsSend(id: number, text: string): true;
  wsRecv(id: number, timeout_ms?: number): WsFrame;
  wsClose(id: number): true;
}
