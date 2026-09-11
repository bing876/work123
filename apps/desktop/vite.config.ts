import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  // 打包产物由 Electron 用 file:// 加载，必须走相对路径，否则资源 404
  base: './',

  server: {
    port: 5173,
    // 端口被占用时直接报错，避免 Electron 等错地址
    strictPort: true,
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
