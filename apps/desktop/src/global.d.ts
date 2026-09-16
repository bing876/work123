import type { WorkbenchBridge } from '@ai-workbench/shared';

declare global {
  interface Window {
    /** 由 electron/preload.ts 通过 contextBridge 注入 */
    workbench?: WorkbenchBridge;
  }
}

/**
 * 第 18 步：<webview> 的 JSX 类型声明搬到了浏览器模块自己家：
 *   apps/desktop/src/browser/webview.d.ts
 * 因为只有那块 UI 用得到它（边界：浏览器相关的东西都收在 browser/ 里）。
 */

export {};
