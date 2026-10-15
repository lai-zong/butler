import type { NextConfig } from 'next';

/**
 * Next.js 配置
 *
 * 设计依据：ADR 0001（技术栈选择 Next.js）、ADR 0004（核心层框架无关）
 *
 * ★ 唯一关键配置是 `extensionAlias`，它解决一个**架构性**的冲突：
 *
 *   核心层（`src/core/**`）与适配器层（`src/adapters/**`）共 90+ 个文件
 *   一律用 `.js` 扩展名导入 TypeScript 模块（`import ... from './log.js'`），
 *   这是 Node ESM 的规范写法 —— 编译后确实产出 `log.js`，
 *   所以这套写法**对 Node 运行是对的**（tsx / vitest 都认）。
 *
 *   ⚠️ 但 Next.js 的 webpack 解析器**不认**这种写法：
 *      它会真的去找 `log.js` 文件，而源码里只有 `log.ts`。
 *      于是所有核心模块导入全部失败。
 *
 *   两条路：
 *     a) 把 90+ 个文件的导入全部改成无扩展名 —— 破坏 Node ESM 规范，
 *        且验证脚本（用 tsx 直跑）会有风险
 *     b) **在打包器侧声明「.js 请求也接受 .ts/.tsx」** —— 一处配置
 *
 *   选 b。理由：**问题出在解析器不认识约定，而不是约定本身错了**。
 *   改 90 个文件去迁就一个工具，是把工具的限制转嫁成代码的债。
 *   ——这也正是 ADR 0004 把核心层做成框架无关的价值：
 *      它按 Node 的规范写，谁来做宿主都只需要一层适配。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  // 类型检查与 lint 由 `pnpm typecheck` / `pnpm lint` 单独跑，
  // 构建时不重复跑（它们在 CI 里是独立步骤，失败更易定位）
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  webpack: (config) => {
    /**
     * 让 `.js` 请求也匹配 `.ts` / `.tsx`。
     *
     * ⚠️ 顺序有意义：`.ts` 在 `.tsx` 之前 —— 否则一个同名文件
     *    两边都存在时，会选择 `.tsx`。
     */
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };

    return config;
  },
};

export default nextConfig;
