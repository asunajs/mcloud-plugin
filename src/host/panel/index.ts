// 组合根之一（面板）：把宿主装进端口，再把入口要的东西导出。
//
// **只有这个目录能 import 'panel:host'**。其它层拿端口（`src/ports/*`）。
// import 这个文件本身就完成装配（装 I/O、装日志）—— 四个 entry 都从这里进。

import { installIo } from '../../ports/io.ts';
import { configureLogger } from '../../ports/log.ts';
import { installPanel } from '../../ports/panel.ts';
import { panel, panelIo, panelLogger } from './impl.ts';

installIo(panelIo);
configureLogger(panelLogger);
// 业务层（taskReadiness / 路由）要改任务状态时走 panelAccess()；这里装上。
installPanel(panel);

export { panel, panelIo };
export { defineTask, payloadOf } from './task.ts';
export type { TaskDef, TaskHandler, TaskPayload, RouterRequest, RouterResponse } from '../../ports/panel.ts';
