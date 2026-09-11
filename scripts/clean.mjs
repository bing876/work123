/**
 * 清理各工作区的构建产物。
 * 用独立脚本而不是 pnpm 脚本里的内联 node -e，避免 Windows cmd 的引号转义问题。
 */
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'packages/shared/dist',
  'apps/desktop/dist',
  'apps/desktop/dist-electron',
];

for (const target of targets) {
  const full = join(root, target);
  rmSync(full, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
