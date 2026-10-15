#!/usr/bin/env node
/**
 * 管家式 AI · 命令行入口
 *
 * 设计依据：用户要求「靠 cmd 窗口中输入 butler web 就能成功启动」
 *
 * ★ 机制说明（与 `dsh web` 同一套）：
 *   `package.json` 里声明 `bin` 字段，npm 安装时自动生成三个转发壳
 *   （`butler` / `butler.cmd` / `butler.ps1`），它们做的事只是
 *   「用 node 跑这个文件」—— 没有任何魔法。
 *
 * ★ 为什么用 .mjs 而不是 .ts：
 *   ① 这个文件要在 `pnpm install` 之后**立刻**能跑，
 *      而 .ts 需要 tsx 才能执行 —— 多一层依赖就多一种"起不来"的可能
 *   ② 它是**启动器**，职责是"找到并启动应用"，不是应用本身。
 *      启动器越少依赖越好（连依赖都还没装的时候它也要能给出有用的提示）
 *
 * ★ 为什么不用 commander 之类的参数解析库：
 *   只有 4 个子命令、7 个选项。手写解析 60 行就够，
 *   而多一个依赖会在"依赖没装好"时让 CLI 自己也起不来 ——
 *   那正是最需要它说话的时候。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════════════════════════════
// 项目定位
// ═══════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));
/** 项目根目录（bin/ 的上一级）。 */
const ROOT = resolve(HERE, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ═══════════════════════════════════════════════════════════
// 输出
// ═══════════════════════════════════════════════════════════

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

const say = (s = '') => process.stdout.write(`${s}\n`);
const ok = (s) => say(`  ${C.green}✓${C.reset} ${s}`);
const bad = (s) => say(`  ${C.red}✗${C.reset} ${s}`);
const warn = (s) => say(`  ${C.yellow}!${C.reset} ${s}`);
const dim = (s) => say(`  ${C.dim}${s}${C.reset}`);

// ═══════════════════════════════════════════════════════════
// 参数解析
// ═══════════════════════════════════════════════════════════

/**
 * 手写解析（刻意不引依赖）。
 *
 * ⚠️ 一个真实踩过的坑：`--port=3000` 与 `--port 3000` 两种写法
 *    用户都会用，必须都支持 —— 只支持一种会让人以为"命令没生效"。
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }

    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(0, eq).replace(/^--?/, '')] = a.slice(eq + 1);
      continue;
    }

    const key = a.replace(/^--?/, '');
    const next = argv[i + 1];

    // 布尔开关 vs 带值选项：看下一个是不是另一个选项
    if (next === undefined || next.startsWith('-')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }

  return { flags, positional };
}

// ═══════════════════════════════════════════════════════════
// 环境文件
// ═══════════════════════════════════════════════════════════

/**
 * 载入 `.env.local`。
 *
 * ★ 为什么 CLI 自己载入，而不靠 `next dev`：
 *   `butler doctor` 要在**不启动 Next** 的情况下检查环境变量。
 *   依赖框架载入的话，"自检"就必须先把服务跑起来 —— 本末倒置。
 *
 * ⚠️ 用 Node 内建 `process.loadEnvFile`（20.12+），不引入 dotenv。
 */
function loadEnv() {
  const path = join(ROOT, '.env.local');
  if (!existsSync(path)) return { loaded: false, path };
  try {
    process.loadEnvFile(path);
    return { loaded: true, path };
  } catch {
    return { loaded: false, path };
  }
}

// 所有子命令都在载入环境后进行
loadEnv();

// ═══════════════════════════════════════════════════════════
// 依赖检查
// ═══════════════════════════════════════════════════════════

function depsInstalled() {
  return existsSync(join(ROOT, 'node_modules', 'next', 'package.json'));
}

function nextCli() {
  // ⚠️ 直接定位 next 的 CLI 文件，而不依赖 PATH 里有 next
  return join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
}

function requireDeps() {
  if (depsInstalled()) return true;

  say();
  bad('依赖尚未安装');
  say();
  dim('请先执行：');
  say(`    cd "${ROOT}"`);
  say('    pnpm install');
  say();
  dim('（没有 pnpm 的话：npm install -g pnpm）');
  say();
  return false;
}

// ═══════════════════════════════════════════════════════════
// 端口
// ═══════════════════════════════════════════════════════════

import { createServer } from 'node:net';

/** 端口是否可用。 */
function portFree(port) {
  return new Promise((resolveP) => {
    const srv = createServer();
    srv.once('error', () => resolveP(false));
    srv.once('listening', () => srv.close(() => resolveP(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 从 startPort 起找第一个可用端口。 */
async function findFreePort(startPort) {
  for (let p = startPort; p < startPort + 20; p++) {
    if (await portFree(p)) return p;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// 子命令：web
// ═══════════════════════════════════════════════════════════

async function cmdWeb(flags) {
  if (!requireDeps()) process.exit(1);

  const wantPort = Number(flags['port'] ?? flags['p'] ?? 3000);
  const prod = flags['prod'] === true;
  const shouldOpen = flags['open'] !== false && flags['no-open'] !== true;

  if (!Number.isInteger(wantPort) || wantPort < 1 || wantPort > 65535) {
    bad(`端口 "${flags['port'] ?? flags['p']}" 不是有效端口号（1—65535）`);
    process.exit(1);
  }

  // ★ 生产模式需要先构建 —— 明确说清怎么做，而不是抛一个 Next 的英文错误
  if (prod && !existsSync(join(ROOT, '.next', 'BUILD_ID'))) {
    say();
    bad('生产模式需要先构建，但没找到构建产物');
    say();
    dim('先执行：');
    say('    butler build');
    say();
    dim('或者去掉 --prod 直接用开发模式（无需构建）：');
    say('    butler web');
    say();
    process.exit(1);
  }

  /**
   * ★ 端口被占用时**自动换一个**，而不是报错退出。
   *
   *   理由：用户敲 `butler web` 的意图是"我要用"，不是"我要 3000 端口"。
   *   报 EADDRINUSE 让他自己去查是谁占了，是把系统的问题推给用户。
   */
  const port = await findFreePort(wantPort);
  if (port === null) {
    bad(`端口 ${wantPort} 起连续 20 个都被占用，找不到可用端口`);
    process.exit(1);
  }
  if (port !== wantPort) {
    warn(`端口 ${wantPort} 被占用，已改用 ${port}`);
  }

  const url = `http://localhost:${port}`;

  say();
  say(`  ${C.bold}管家式 AI${C.reset} ${C.dim}v${pkg.version}${C.reset}`);
  say(`  ${C.dim}模式：${prod ? '生产' : '开发（改代码即时生效）'}${C.reset}`);
  say(`  ${C.dim}数据：${process.env['BUTLER_DATA_DIR'] ?? join(ROOT, '.butler-data')}${C.reset}`);
  say();
  say(`  ${C.cyan}${url}${C.reset}`);
  say();

  if (process.env['DEEPSEEK_API_KEY'] === undefined || process.env['DEEPSEEK_API_KEY'].trim() === '') {
    warn('未配置 DEEPSEEK_API_KEY —— 对话不可用（记忆治理页面仍可用）');
    dim(`在 .env.local 里设置，或先跑 butler doctor 看详细自检`);
    say();
  }

  // ★ stdio: 'inherit' —— 让 Next 的输出直接进终端
  //   （不捕获输出：一是要实时看到编译进度，二是避免管道缓冲问题）
  const args = [nextCli(), prod ? 'start' : 'dev', '-p', String(port)];

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  // 自动开浏览器（等一下就绪）
  if (shouldOpen) {
    setTimeout(() => {
      const opener =
        process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
      try {
        spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
      } catch {
        // 打不开浏览器不是错误（无头环境、容器里都正常）
      }
    }, prod ? 1200 : 5000);
  }

  /**
   * ★ 退出时必须**转达**子进程的退出码，且要把 Ctrl+C 传下去。
   *
   *   ⚠️ 不处理的话，Ctrl+C 只杀了 CLI 自己，Next 变成孤儿进程
   *      继续占着端口 —— 下次 `butler web` 就会说"端口被占用"，
   *      而用户以为自己已经关掉了。这是很常见也很难受的坑。
   */
  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      // 已退出
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal !== null) process.exit(0);
    process.exit(code ?? 0);
  });
}

// ═══════════════════════════════════════════════════════════
// 子命令：doctor
// ═══════════════════════════════════════════════════════════

async function cmdDoctor() {
  say();
  say(`  ${C.bold}管家式 AI · 环境自检${C.reset}`);
  say(`  ${'─'.repeat(52)}`);

  let fatal = 0;

  // ── ① Node 版本 ──
  const major = Number(process.versions.node.split('.')[0]);
  const need = Number((pkg.engines?.node ?? '>=20.11').replace(/[^0-9.]/g, '').split('.')[0]);
  if (major >= need) ok(`Node.js  ${process.versions.node}`);
  else {
    bad(`Node.js  ${process.versions.node}（需要 ≥ ${need}）`);
    fatal++;
  }

  // ── ② 依赖 ──
  if (depsInstalled()) ok('依赖     已安装');
  else {
    bad('依赖     未安装 —— 先执行 pnpm install');
    fatal++;
  }

  // ── ③ 环境文件 ──
  const envPath = join(ROOT, '.env.local');
  if (existsSync(envPath)) ok('.env.local  已载入');
  else {
    warn('.env.local  不存在 —— 用 .env.example 复制一份');
    dim(`cp .env.example .env.local`);
  }

  if (fatal > 0) {
    say();
    say(`  ${C.red}有 ${fatal} 项必须先解决${C.reset}`);
    say();
    process.exit(1);
  }

  // ── ④ 环境变量（复用 core/config 的解析，看到的就是代码看到的）──
  say();
  say(`  ${C.dim}环境变量（显示的是**实际生效值**）${C.reset}`);

  /**
   * ⚠️ 这里要加载 `.ts` 模块，而 Node 默认不认 TypeScript。
   *
   *   第一版直接用 `import()` 加载 —— **静默失败**，返回空对象，
   *   于是自检显示出一排 `undefined`，看起来像"配置全坏了"。
   *
   *   ★ 修法的关键在于**如实报告加载是否成功**：
   *     加载不到就说"读不到配置源码"，而不是继续打印垃圾数据。
   *     （一个说"我不知道"的自检工具，比一个说错话的有用。）
   *
   *   两条加载路径，按可用性依次尝试：
   *     ① 项目自带的 tsx（devDependency，正常安装后都有）
   *     ② Node 24 的 `--experimental-strip-types`（tsx 缺失时的兜底）
   */
  let cfg = null;
  let cfgHow = '';
  const cfgPath = join(ROOT, 'src', 'core', 'config', 'env.ts');

  const tsxLoader = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (existsSync(tsxLoader)) {
    try {
      const { register } = await import(`file://${tsxLoader.replace(/\\/g, '/')}`);
      register();
      cfg = await import(`file://${cfgPath.replace(/\\/g, '/')}`);
      cfgHow = 'tsx';
    } catch (err) {
      cfg = null;
    }
  }
  if (cfg === null) {
    try {
      cfg = await import(`file://${cfgPath.replace(/\\/g, '/')}`);
      cfgHow = 'node 原生类型剥离';
    } catch {
      cfg = null;
    }
  }

  const key = process.env['DEEPSEEK_API_KEY']?.trim() ?? '';
  if (key.length > 0) ok(`DEEPSEEK_API_KEY  已设置（${key.length} 字符）`);
  else warn('DEEPSEEK_API_KEY  未设置 —— 对话不可用');

  if (cfg === null) {
    // ★ 不假装知道 —— 明确说"读不到"，并给出原因与下一步
    say();
    warn('读不到配置源码，无法显示各变量的生效值');
    dim('原因：当前 Node 无法直接加载 .ts 模块，且未找到 tsx');
    dim('解决：确认依赖已装好（pnpm install），或直接看 .env.example 的说明');
    say();
  } else {
    if (cfgHow !== 'tsx') dim(`（通过 ${cfgHow} 读取配置）`);

    /**
     * ⚠️ 只显示**非默认值**的环境变量。
     *
     *   把 16 个变量全列出来会让这张表变成噪音，用户看不出
     *   "哪些是我改过的" —— 而那是他唯一关心的事。
     */
    const shown = [];
    const push = (name, value, fallback) => {
      if (value !== fallback) shown.push(`${name}=${value}`);
    };
    push('MAX_ROUNDS_PER_SESSION', cfg.limitsConfig?.maxRoundsPerSession, 8);
    push('TOOL_TIMEOUT_MS', cfg.limitsConfig?.toolTimeoutMs, 15000);
    push('ROUTING_CONFIDENCE_THRESHOLD', cfg.routingConfig?.confidenceThreshold, 0.6);
    push('FITNESS_EMA_ALPHA', cfg.memoryConfig?.emaAlpha, 0.15);
    push(
      'MEMORY_DORMANT_DAYS',
      Math.round((cfg.memoryConfig?.dormantAfterMs ?? 0) / 86400000),
      60,
    );
    push('DAILY_TOKEN_TASK_LIMIT', cfg.limitsConfig?.dailyTokenTaskLimit, 10);
    push('EXPLORATORY_RECALL_RATIO', cfg.memoryConfig?.exploratoryRatio, 0.1);

    if (shown.length > 0) {
      for (const s of shown) ok(`已覆盖默认值  ${s}`);
    } else {
      dim('全部使用默认值（没有覆盖项）');
    }

    // ── 解析问题（写错的环境变量）──
    const probs = typeof cfg.configProblems === 'function' ? cfg.configProblems() : [];
    if (probs.length > 0) {
      say();
      for (const p of probs) {
        warn(`${p.key} = "${p.raw}" ${p.why} → 已改用 ${p.usedInstead}`);
      }
    }

    // ── 预留位提醒 ──
    //
    // ⚠️ 只在**与默认值不同**时提醒。
    //    `.env.local` 通常是照抄 `.env.example` 来的，里面就有这些
    //    预留位（且值等于默认值）。全报一遍会让这张表变成噪音，
    //    用户会学会忽略所有警告 —— 那比不报更糟。
    const reserved = Array.isArray(cfg.RESERVED_KEYS) ? cfg.RESERVED_KEYS : [];
    /** 预留位的默认值（与 `.env.example` 一致）。 */
    const RESERVED_DEFAULTS = {
      BEHAVIOR_OBSERVATION_ENABLED: 'false',
      LOCAL_FIRST: 'true',
      EXPORT_INCLUDE_CREDENTIALS: 'false',
    };
    const setReserved = reserved.filter((k) => {
      const v = (process.env[k] ?? '').trim();
      if (v.length === 0) return false;
      if (k.startsWith('VISION_')) return true;
      const dflt = RESERVED_DEFAULTS[k];
      return dflt === undefined ? true : v.toLowerCase() !== dflt;
    });
    if (setReserved.length > 0) {
      say();
      for (const k of setReserved) {
        warn(`${k} 已设置且与默认值不同，但**当前版本尚未接入** —— 填了不生效`);
      }
      dim('（这几个变量的用途见 .env.example 的「预留位」一节）');
    }

    var detectedDataDir = cfg.storageConfig?.dataDir;
  }

  // ── ⑤ 数据目录 ──
  say();
  const dataDir = detectedDataDir ?? process.env['BUTLER_DATA_DIR'] ?? join(ROOT, '.butler-data');
  if (existsSync(dataDir)) {
    const evFile = join(dataDir, 'events.jsonl');
    if (existsSync(evFile)) {
      const lines = readFileSync(evFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      let bad = 0;
      for (const l of lines) {
        try {
          JSON.parse(l);
        } catch {
          bad++;
        }
      }
      if (bad === 0) ok(`事件文件  ${lines.length} 条 · 无损坏行`);
      else warn(`事件文件  ${lines.length} 条 · ${bad} 行损坏（启动时会跳过）`);
    } else {
      dim('数据目录存在，还没有事件文件（首次对话后生成）');
    }
  } else {
    dim('数据目录尚不存在（首次启动时自动创建）');
  }

  // ── ⑥ 端口 ──
  const freePort = await findFreePort(3000);
  if (freePort === 3000) ok('端口 3000  空闲');
  else if (freePort !== null) warn(`端口 3000  被占用 —— butler web 会自动改用 ${freePort}`);
  else bad('端口 3000  起连续 20 个都被占用');

  // ── ⑦ 生产构建 ──
  if (existsSync(join(ROOT, '.next', 'BUILD_ID'))) ok('生产构建   已存在（可用 butler web --prod）');
  else dim('尚无生产构建（butler web 走开发模式，不需要构建）');

  say();
  say(`  ${'─'.repeat(52)}`);
  say(`  ${C.green}自检通过${C.reset} —— 可以运行：`);
  say();
  say(`    ${C.bold}butler web${C.reset}`);
  say();
}

// ═══════════════════════════════════════════════════════════
// 子命令：launcher-check（供 启动.bat 调用）
// ═══════════════════════════════════════════════════════════

/**
 * 双击启动前的环境准备。
 *
 * ★ 为什么这些逻辑在 **Node 里**而不是 `.bat` 里：
 *
 *   cmd.exe 逐行解析 `.bat` 时用的是 OEM 代码页，且**在
 *   `chcp 65001` 生效之前**就已经解析过前面的行了。中文注释或
 *   中文 `echo` 会被当成命令执行，报出
 *   `'???' is not recognized as an internal or external command`。
 *
 *   ⚠️ 这个失败**看起来是随机的** —— 它取决于多字节字符的边界
 *      落在哪里。我试了三种修法（挪 chcp、存成 CRLF、去掉 BOM）
 *      都仍会间歇性出现。
 *
 *   所以：`.bat` 里**一个非 ASCII 字节都没有**，用户看到的所有中文
 *   都由这个 Node 脚本打印。Node 处理 UTF-8 没有对齐问题。
 *
 * ⚠️ 这个子命令必须能在**依赖还没装**的情况下运行 ——
 *    它的职责之一就是"把依赖装上"。所以它不能 import 任何
 *    项目内的模块，也不能用正则/模板之外的东西。
 */
async function cmdLauncherCheck() {
  say();
  say(`  ${C.bold}管家式 AI${C.reset} ${C.dim}— 可审计的记忆治理与自进化系统${C.reset}`);
  say(`  ${'─'.repeat(46)}`);
  say();

  // ── ① Node 版本 ──
  const major = Number(process.versions.node.split('.')[0]);
  const minRaw = (pkg.engines?.node ?? '>=20.11').replace(/[^0-9.]/g, '');
  const minMajor = Number(minRaw.split('.')[0]);
  if (major < minMajor) {
    bad(`Node.js ${process.versions.node} 版本过低（需要 ≥ ${minMajor}）`);
    say();
    dim('请到 https://nodejs.org/zh-cn 下载 LTS 版本覆盖安装');
    say();
    return 1;
  }
  ok(`Node.js ${process.versions.node}`);

  // ── ② 依赖 ──
  if (depsInstalled()) {
    ok('依赖已就绪');
  } else {
    say();
    say(`  ${C.dim}首次运行，正在安装依赖（需要几分钟，请耐心等待）${C.reset}`);
    say();

    // pnpm 缺失时先装 pnpm —— 项目用 pnpm 管理，lock 文件也是它的
    const hasPnpm = await new Promise((resolveP) => {
      const p = spawn('pnpm', ['--version'], { stdio: 'ignore', shell: true });
      p.on('error', () => resolveP(false));
      p.on('exit', (code) => resolveP(code === 0));
    });

    if (!hasPnpm) {
      say(`  ${C.dim}未找到 pnpm，正在通过 npm 安装…${C.reset}`);
      const code = await runShell('npm', ['install', '-g', 'pnpm']);
      if (code !== 0) {
        bad('pnpm 安装失败');
        say();
        dim('请手动执行下面这条命令，然后重新双击 启动.bat：');
        say('    npm install -g pnpm');
        say();
        return 1;
      }
    }

    const code = await runShell('pnpm', ['install']);
    if (code !== 0) {
      bad('依赖安装失败');
      say();
      say('  常见原因与对策：');
      dim('· 网络问题     → 换用国内镜像：');
      say('                   pnpm config set registry https://registry.npmmirror.com');
      dim('· 权限不足     → 右键「启动.bat」选「以管理员身份运行」');
      dim('· 磁盘空间不足 → 清理磁盘后重试');
      say();
      return 1;
    }
    ok('依赖安装完成');
  }

  // ── ③ 环境变量文件 ──
  const envPath = join(ROOT, '.env.local');
  const examplePath = join(ROOT, '.env.example');
  if (!existsSync(envPath) && existsSync(examplePath)) {
    try {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(examplePath, envPath);
      ok('已从模板创建 .env.local');
      say();
      warn('还需要填入模型密钥才能使用对话功能');
      dim('用记事本打开 .env.local，找到这一行并填上你的密钥：');
      say('    DEEPSEEK_API_KEY=');
      dim('申请地址：https://platform.deepseek.com');
      dim('（不填也能启动，「记忆库」等页面可以正常查看）');
    } catch {
      warn('无法创建 .env.local —— 请手动复制 .env.example 为 .env.local');
    }
  }

  // ── ④ 密钥检查（提醒但不阻断）──
  //
  // ⚠️ 这里**不 return 1** —— 没有密钥只是"对话不可用"，
  //    记忆治理页面仍然能用。为此拦下启动是过度反应。
  const key = (process.env['DEEPSEEK_API_KEY'] ?? '').trim();
  if (key.length === 0) {
    say();
    warn('未配置 DEEPSEEK_API_KEY —— 对话功能不可用');
    dim('在 .env.local 里设置后重启即可');
  }

  say();
  say(`  ${'─'.repeat(46)}`);
  say(`  ${C.dim}正在启动，浏览器会自动打开…${C.reset}`);
  say(`  ${C.dim}关闭窗口即可停止服务。${C.reset}`);
  say(`  ${'─'.repeat(46)}`);

  return 0;
}

/** 跑一条外部命令并等它结束（shell: true 以便找到 .cmd 包装器）。 */
function runShell(cmd, args) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
    child.on('error', () => resolveP(1));
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

// ═══════════════════════════════════════════════════════════
// 子命令：build / validate
// ═══════════════════════════════════════════════════════════

function runNode(args) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => resolveP(code ?? 0));
  });
}

async function cmdBuild() {
  if (!requireDeps()) process.exit(1);
  say();
  say(`  ${C.dim}构建生产版本…${C.reset}`);
  say();
  const code = await runNode([nextCli(), 'build']);
  say();
  if (code === 0) ok('构建完成 —— 现在可以用 butler web --prod');
  else bad(`构建失败（退出码 ${code}）`);
  process.exit(code);
}

const VALIDATE_SCRIPTS = {
  1: '01-orchestration.ts',
  2: '02-memory-loop.ts',
  3: '03-tool-use.ts',
  4: '04-activity-profile.ts',
  5: '05-mcp.ts',
  6: '06-persistence.ts',
  7: '07-runtime-restart.ts',
};

async function cmdValidate(positional) {
  if (!requireDeps()) process.exit(1);

  const which = positional[0] ?? 'all';

  const runOne = async (n) => {
    const file = VALIDATE_SCRIPTS[n];
    if (!file) {
      bad(`没有验证 ${n}（可用：1—7）`);
      return 1;
    }
    say();
    say(`  ${C.bold}验证 ${n}${C.reset}  ${C.dim}${file}${C.reset}`);
    say();
    return runNode([join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'validate', file)]);
  };

  if (which === 'all') {
    const codes = [];
    for (const n of Object.keys(VALIDATE_SCRIPTS)) codes.push([n, await runOne(n)]);
    say();
    say(`  ${'─'.repeat(52)}`);
    for (const [n, c] of codes) {
      if (c === 0) ok(`验证 ${n} 通过`);
      else bad(`验证 ${n} 失败（退出码 ${c}）`);
    }
    say();
    process.exit(codes.every(([, c]) => c === 0) ? 0 : 1);
  }

  const code = await runOne(String(which));
  process.exit(code);
}

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

function usage() {
  say();
  say(`  ${C.bold}管家式 AI${C.reset} ${C.dim}v${pkg.version}${C.reset}`);
  say(`  ${C.dim}可审计的记忆治理与自进化系统${C.reset}`);
  say();
  say(`  ${C.bold}用法${C.reset}`);
  say(`    butler <命令> [选项]`);
  say();
  say(`  ${C.bold}命令${C.reset}`);
  say(`    web                启动界面（默认开发模式，无需构建）`);
  say(`    doctor             环境自检 —— 显示每个环境变量的实际生效值`);
  say(`    build              构建生产版本`);
  say(`    validate [1-7|all] 跑验证脚本（零 token，确定性）`);
  say();
  say(`  ${C.bold}butler web 的选项${C.reset}`);
  say(`    -p, --port <端口>   监听端口（默认 3000，被占用则自动 +1）`);
  say(`    --prod             生产模式（需先 butler build）`);
  say(`    --no-open          不自动打开浏览器`);
  say();
  say(`  ${C.bold}环境变量${C.reset}`);
  say(`    BUTLER_DATA_DIR    数据目录（默认 ./.butler-data）`);
  say(`    DEEPSEEK_API_KEY   模型密钥（对话必需）`);
  say();
  dim('完整列表见 .env.example · 运行 butler doctor 查看当前生效值');
  say();
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  /**
   * ⚠️ 全局开关必须在 switch **之前**判断。
   *
   *   原因：解析器把 `--version` 收进 `flags`（它是选项不是子命令），
   *   于是 `positional[0]` 是 undefined，会落到 usage 分支 ——
   *   用户敲 `butler --version` 却看到帮助，看起来像命令没生效。
   */
  if (flags['version'] === true || flags['v'] === true) {
    say(pkg.version);
    return;
  }
  if (cmd === undefined && (flags['help'] === true || flags['h'] === true)) {
    usage();
    return;
  }
  if (flags['help'] === true || flags['h'] === true) {
    usage();
    return;
  }

  switch (cmd) {
    case 'web':
    case 'dev':
    case 'start':
      await cmdWeb(flags);
      return;

    case 'doctor':
      await cmdDoctor();
      return;

    case 'launcher-check': {
      const code = await cmdLauncherCheck();
      process.exit(code);
    }

    case 'build':
      await cmdBuild();
      return;

    case 'validate':
      await cmdValidate(positional.slice(1));
      return;

    case undefined:
      usage();
      return;

    default:
      bad(`未知命令：${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  say();
  bad(`执行出错：${err?.message ?? String(err)}`);
  if (process.env['BUTLER_DEBUG'] === '1' && err?.stack) say(err.stack);
  say();
  process.exit(1);
});
