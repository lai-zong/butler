/**
 * Vitest 配置。
 *
 * ★ 只做一件事：把 Next 的 `@/` 别名映射到 `src/`。
 *   core 层测试只用相对路径，所以以前不需要；这次开始测
 *   `src/app/server/uiData.ts`（它 import 了 `@/core/...`），必须有别名。
 */

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
