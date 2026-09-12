/**
 * 第 8 步：通知通道 —— **按说明书留空位**。
 *
 * 真推送（微信 / OpenClaw / 短信）本步一律不接：这里只打一行日志。
 * 契约说死了两件事：
 *   1. done 收尾必须调它（调用点在 /agent/task/finish，写完 unread 之后）；
 *   2. 它失败**绝不影响任务**：调用方 try/catch 吞掉，任务仍是 done、红点和文档仍在。
 * 想验证“通知挂了任务还成”，.env 里设 NOTIFY_STUB_FAIL=1 —— 本桩函数就故意抛错。
 */
export function notifyUser(userId: number, text: string): void {
  if (process.env.NOTIFY_STUB_FAIL === '1') {
    throw new Error('通知桩故意失败（NOTIFY_STUB_FAIL=1），用来验证 done 不受影响');
  }
  console.log(`[notify:noop] 未接真实推送 · user=${userId} · ${text}`);
}
