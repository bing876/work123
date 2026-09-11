/**
 * Electron 启动包装器（dev 与 start 都走它）。
 *
 * 为什么需要它：
 *   部分虚拟机 / 远程桌面 / 容器环境缺少初始化 Chromium 沙箱所需的系统能力，
 *   GPU 进程会反复重启并最终致命退出，表现为 Electron 启动 1~2 秒后崩掉：
 *     FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.
 *   这不是代码问题，是运行环境限制。
 *
 * 策略：
 *   先按默认（安全）参数启动。只有确认是上面这种情况时，才自动加一次
 *   --no-sandbox 重试。
 *   普通桌面环境永远不会走到这个回退分支，安全设置保持默认。
 *   走到回退时会在终端打印醒目提示，不会静默降级。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
/** electron 包在 Node 环境下 require 出来就是可执行文件路径 */
const electronBin = require('electron');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Chromium GPU 沙箱初始化失败的日志特征 */
const GPU_SANDBOX_FAILURE = /GPU process isn't usable|gpu_data_manager_impl_private/i;
/** Windows 下 Chromium 致命错误的退出码（0x80000003） */
const FATAL_EXIT_CODE = 2147483651;
/** 只有「启动后很快就崩」才算环境问题，跑了几分钟才崩不算 */
const EARLY_CRASH_MS = 15_000;

const passthroughArgs = process.argv.slice(2);

function launch(extraArgs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();

    const child = spawn(electronBin, ['.', ...extraArgs, ...passthroughArgs], {
      cwd: appDir,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let output = '';
    const tap = (stream, sink) =>
      stream.on('data', (chunk) => {
        output += chunk.toString();
        sink.write(chunk);
      });
    tap(child.stdout, process.stdout);
    tap(child.stderr, process.stderr);

    // 把 Ctrl+C / concurrently 的终止信号透传给 Electron，避免留下孤儿进程
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => child.kill(signal));
    }

    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        output,
        elapsed: Date.now() - startedAt,
      });
    });
  });
}

let result = await launch([]);

const isGpuSandboxFailure =
  result.code === FATAL_EXIT_CODE &&
  result.elapsed < EARLY_CRASH_MS &&
  GPU_SANDBOX_FAILURE.test(result.output);

if (isGpuSandboxFailure) {
  console.warn(
    [
      '',
      '[launch] ⚠️  当前环境无法初始化 Chromium 的进程沙箱（常见于虚拟机 / 远程桌面 / 容器）。',
      '[launch]    自动回退 --no-sandbox 重试 —— 这只是让窗口能开起来，',
      '[launch]    渲染进程依然拿不到 Node（contextIsolation / nodeIntegration 设置未变）。',
      '[launch]    在普通桌面环境下不会出现这条提示。',
      '',
    ].join('\n'),
  );
  result = await launch(['--no-sandbox']);
}

console.log(
  `[launch] Electron 已退出：code=${result.code} signal=${result.signal ?? '无'}，运行 ${Math.round(result.elapsed / 1000)}s`,
);

process.exit(result.code);
