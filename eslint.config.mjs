import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * ESLint 9 flat config。
 *
 * 目标（与项目现状匹配）：
 *   · 覆盖 `.ts` 与 `.tsx`（旧配置只有 `.ts`，8,700 行界面从未被检查）
 *   · 只开 `recommended` 中**不会要求大范围重写**的规则；格式交给 Prettier
 *   · 不开启 type-aware（需要 program，构建慢且会因生成文件抖动）
 */
export default [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'coverage/**',
      '*.config.*',
      'next-env.d.ts',
      // 启动器是既有 CLI（E 盘项目自带，本次合并保留）；不为它引入风格改动
      'bin/**',
    ],
  },
  js.configs.recommended,
  {
    // 仓库里的小工具脚本是 Node ESM；给它们补上运行环境全局量
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript 自己会查未定义变量；ESLint 的 no-undef 在 TS 上误报多
      'no-undef': 'off',
      // 以下规则在现有代码里大量存在，且不属于本轮修复范围；
      // 先关掉，避免用“改 200 处 any”来换一个绿勾。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // this 别名用于"可调用对象"写法（MCP 工具 spec），是刻意保留的
      '@typescript-eslint/no-this-alias': 'off',
      // 字符类里的 \[ 是防御性写法，语义正确；不为一个风格规则改正则
      'no-useless-escape': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];
