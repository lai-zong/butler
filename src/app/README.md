# app/ 层的导入约定

## 一句话

**`src/app/**` 里一律用 `@/` 别名导入，相对导入不带扩展名。**

```ts
// ✅ 正确
import { getRuntime } from '@/app/runtime';
import { Shell } from './shell';
import { remember } from '@/core/memory/store.js';   // core 内部仍是 .js

// ❌ 错误（在 app 层）
import { getRuntime } from '../runtime.js';
import { Shell } from './shell.js';
```

## 为什么

核心层与适配器层（`src/core/**`、`src/adapters/**`）共 90+ 个文件
一律用 `.js` 扩展名导入 TypeScript 模块（`import ... from './log.js'`）。

**这是对的** —— 它是 Node ESM 的规范写法，编译后确实产出 `log.js`，
所以 `tsx` 直跑验证脚本、`vitest` 跑测试都认这套写法。
`ADR 0004` 要求核心层框架无关，按 Node 规范写正是它的一部分。

问题出在 **Next.js 的 webpack 解析器**：它默认不认「`.js` 请求也接受 `.ts`」。

`next.config.ts` 里配了 `extensionAlias` 来桥接，但实测发现它
**对 `@/` 别名可靠、对相对导入不可靠**（同一个配置，两种结果）。

⚠️ 「时灵时不灵」比「完全不支持」更麻烦 —— 它会让人以为是偶发问题，
   浪费时间在"重试一下就好了"上。所以 app 层**统一绕开相对 `.js` 导入**。

## 为什么不去改核心层的 90 个文件

两条路的对比：

| 做法 | 代价 |
|---|---|
| 改 90+ 个核心文件的导入 | 破坏 Node ESM 规范；验证脚本（tsx 直跑）有风险；为了迁就一个工具而改代码 |
| 在打包器侧声明扩展名映射 | 一处配置 |

**问题出在解析器不认识约定，而不是约定本身错了。**
把工具的限制转嫁成代码的债，是更差的选择。

这也正是 `ADR 0004` 把核心层做成框架无关的价值：
**它按 Node 的规范写，谁来做宿主都只需要一层适配。**

## 例外

`src/core/**` 与 `src/adapters/**` **保持 `.js` 扩展名不变**。
它们是框架无关的，不该知道 Next.js 的存在。
