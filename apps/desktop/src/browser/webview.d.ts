import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * 第 18 步 · 浏览器模块：<webview> 的 JSX 类型。
 *
 * Electron 的 <webview> 标签（需要主窗口 webPreferences.webviewTag: true），
 * React 本身不认识它，所以在这里补上类型声明。
 * 放在浏览器模块里（而不是全局 global.d.ts），是因为**只有这个模块**用它。
 */
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        /** 独立会话分区；Phase 3 起按**项目**：persist:workbench-browser-project-{projectId} */
        partition?: string;
        allowpopups?: string;
        useragent?: string;
      };
    }
  }
}

export {};
