import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    // 性能优化目标（见方案 § 13.6）：路由级代码分割 + 首屏预算
    target: 'es2022',
    sourcemap: true,
    // 说明：暂不配置 manualChunks —— 当前入口是内核自检页，尚未引入 React。
    // 正式界面接入后，再按路由做 vendor 拆分。
  },
});
