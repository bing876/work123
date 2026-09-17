import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BrowserInstanceInfo,
  ResourceAlert,
  ResourceGuardSnapshot,
} from '@ai-workbench/shared';
import type { BrowserWorkspace } from '../browser';

/**
 * Phase 4 · 资源守护者（渲染层这一半）
 *
 * 主进程负责采集 / 判定 / 落盘（见 electron/resource-guard.ts），这边只做两件事：
 *   1. **上报实例清单** —— 「最久未使用」排序要用到"每张页最后一次被用是什么时候"，
 *      而标签页的生命周期只有渲染层知道（主进程看到的只是一个个 webContents）；
 *   2. **收提示** —— 主进程判到警戒时广播过来，本阶段把它交给既有的单行人话通道显示，
 *      **不新增任何 UI 元素、不改任何样式**（正式提示界面留给 UI 阶段）。
 *
 * 三条红线（与本阶段边界一一对应）：
 *   - 不上报、不显示、也不做任何"拒绝开页"的动作 —— 提示不是闸门；
 *   - 不参与关闭任何实例：`idleRanking` 只是给用户看的一份排序；
 *   - 不碰分区 / 标签页归属 / 驾驶逻辑（那些仍是 Phase 3 的规矩）。
 */
export interface ResourceGuardView {
  /** 主进程那侧的实时视图（最新采样 / 档位 / 阈值 / 去抖计数） */
  snapshot: ResourceGuardSnapshot | null;
  /** 最近一次警戒提示（本阶段只用于取证与复用既有提示通道） */
  lastAlert: ResourceAlert | null;
  /** 主动拉一次快照（UI 阶段可以按需刷新；本阶段供验收取证） */
  refresh: () => Promise<ResourceGuardSnapshot | null>;
}

export function useResourceGuard(options: {
  ws: BrowserWorkspace;
  /** 收到警戒提示时说什么（复用既有的单行人话通道；不传就只记状态） */
  onAlert?: (alert: ResourceAlert) => void;
}): ResourceGuardView {
  const { ws } = options;
  const onAlertRef = useRef(options.onAlert);
  onAlertRef.current = options.onAlert;
  /**
   * `ws` 每渲染都是新对象（hook 返回的是新字面量），所以放进 ref 用，
   * **effect 的依赖只挂它内部那两个稳定引用** —— 否则 App 每次流式打字都会重跑这个 effect。
   */
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const [snapshot, setSnapshot] = useState<ResourceGuardSnapshot | null>(null);
  const [lastAlert, setLastAlert] = useState<ResourceAlert | null>(null);

  /** 上一次发出去的清单（只在**真的变了**的时候才发，不做固定心跳） */
  const sentRef = useRef('');
  const alertSeenRef = useRef<string>('');

  const refresh = useCallback(async (): Promise<ResourceGuardSnapshot | null> => {
    try {
      const s = await window.workbench?.resourceSnapshot?.();
      if (s) setSnapshot(s);
      return s ?? null;
    } catch {
      return null; // 桥异常不该影响界面（监控是旁路，不是主干）
    }
  }, []);

  /**
   * 上报实例清单。
   *
   * 两个触发源：
   *   1. **结构变化立刻发** —— 开页 / 关页 / 切 tab / 导航 / 标题变化 / 驾驶状态变化
   *      （依赖 `ws.allTabs` 与 `ws.drivingIds` 这两个稳定引用，改了就整块重算）；
   *   2. **20 秒兜底刷新一次** —— 只为一个目的：`lastActiveAt` 不过期。
   *
   * 为什么需要 (2)：`lastActiveAt` 是普通时间戳，记在 workspace 的 ref 里（刻意不进 state，
   * 免得每次用一下页就整块重渲染）。它变的时候**未必**伴随 `allTabs` / `drivingIds` 的引用变化，
   * 光靠事件驱动就可能把"这张页刚被用过"漏掉 —— 而漏掉会让排序把刚用过的页排到前面去挨关，
   * 那正是最不能出错的地方。一次 ipc 就一条几十项的小数组，20 秒一次，量级可以忽略。
   */
  useEffect(() => {
    const send = (): void => {
      const list: BrowserInstanceInfo[] = wsRef.current.instanceList();
      const key = JSON.stringify(
        list.map((x) => [x.wcId, x.agentId, x.projectId, x.title, x.url, x.lastActiveAt, x.driving]),
      );
      if (key === sentRef.current) return; // 内容没变就不发
      sentRef.current = key;
      void window.workbench?.resourceInstances?.(list);
    };
    send();
    const timer = window.setInterval(send, 20_000);
    return () => window.clearInterval(timer);
  }, [ws.allTabs, ws.drivingIds]);

  /**
   * 订阅警戒提示。
   *
   * 用 `id` 去重：主进程在"一直在警戒里 + 冷却已过"时允许再提醒一次，
   * 同一个 id 只处理一遍（React 严格模式下的双调用也不会重复处理）。
   */
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge?.on) return;
    const off = bridge.on('resources', (payload) => {
      if (!payload) return;
      let alert: ResourceAlert;
      try {
        alert = JSON.parse(payload) as ResourceAlert;
      } catch {
        return; // 坏负载忽略，等下一次
      }
      if (alertSeenRef.current === alert.id) return;
      alertSeenRef.current = alert.id;
      setLastAlert(alert);
      onAlertRef.current?.(alert);
      void refresh();
    });
    // 挂载时先同步一次（应用启动后才登录的场景也能立刻拿到当前档位）
    void refresh();
    return off;
  }, [refresh]);

  return { snapshot, lastAlert, refresh };
}
