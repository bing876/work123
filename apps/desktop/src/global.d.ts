import type { DetailedHTMLProps, HTMLAttributes } from 'react';
import type { WorkbenchBridge } from '@ai-workbench/shared';

declare global {
  interface Window {
    /** 由 electron/preload.ts 通过 contextBridge 注入 */
    workbench?: WorkbenchBridge;
  }

  namespace JSX {
    interface IntrinsicElements {
      /**
       * Electron 的 <webview> 标签（需要主窗口 webPreferences.webviewTag: true）。
       * React 本身不认识这个标签，这里补上类型声明。
       */
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        /** 独立会话分区，例如 persist:workbench-browser */
        partition?: string;
        allowpopups?: string;
        useragent?: string;
      };
    }
  }
}

export {};
