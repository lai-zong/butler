#!/usr/bin/env node
/**
 * pnpm dev —— 单地址启动器
 *
 * 只做三件事：
 *   1. 启动 next dev（默认 3000，可用 PORT 覆盖）
 *   2. 等根页面首次编译完成（GET / 返回 2xx/3xx）
 *   3. 自动打开同一个地址
 *
 * 不做独立启动页、不换端口：启动动画由应用自身的服务端首帧渲染。
 * 首次编译的等待发生在终端里，这是“单地址”方案的既定代价。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT_BIN = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const HOST = '127.0.0.1';
const WAIT_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function isPortFree(port) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  const explicit = process.env.PORT;
  if (explicit !== undefined && explicit.trim().length > 0) {
    const port = Number(explicit);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`[butler] PORT 不是合法端口：${explicit}`);
      process.exit(1);
    }
    if (!(await isPortFree(port))) {
      console.error(`[butler] 端口 ${port} 已被占用。换一个：PORT=3001 pnpm dev`);
      process.exit(1);
    }
    return port;
  }

  for (let port = 3000; port < 3020; port += 1) {
    if (await isPortFree(port)) return port;
  }
  return 3000;
}

function openBrowser(url) {
  if (process.env.BUTLER_NO_OPEN === '1' || process.env.BUTLER_NO_OPEN === 'true') {
    console.log('[butler] 已关闭自动打开（BUTLER_NO_OPEN=1）');
    return;
  }
  if (process.env.CI === 'true' || process.env.CI === '1') {
    console.log('[butler] CI 环境，跳过自动打开');
    return;
  }

  let command;
  let args;
  let verbatim = false;
  if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" "${url}"`];
    verbatim = true;
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    child.on('error', () => {
      console.log(`[butler] 无法自动打开浏览器，请手动访问 ${url}`);
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        console.log(`[butler] 自动打开未成功，请手动访问 ${url}`);
      }
    });
    child.unref();
  } catch {
    console.log(`[butler] 无法自动打开浏览器，请手动访问 ${url}`);
  }
}

async function waitForPage(url, timeoutMs, hasExited) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (hasExited()) return false;
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        redirect: 'manual',
        signal: globalThis.AbortSignal.timeout(30_000),
      });
      // 只把真正可渲染的响应算作就绪；5xx 继续等，让编译错误有机会自愈。
      if (res.status >= 200 && res.status < 400) return true;
    } catch {
      // 还没监听或本次编译超时，继续等
    }
    await sleep(280);
  }
  return false;
}

if (!existsSync(NEXT_BIN)) {
  console.error('[butler] 找不到 next。请先在项目根目录运行 pnpm install。');
  process.exit(1);
}

const port = await pickPort();
const url = `http://${HOST}:${port}`;

console.log('');
console.log('\u001b[2m▸ 管家 · 正在启动本地服务…\u001b[0m');
console.log('\u001b[2m  首次编译需要一点时间；页面就绪后会自动打开。\u001b[0m');

let childExited = false;
const child = spawn(process.execPath, [NEXT_BIN, 'dev', '-p', String(port), '-H', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port) },
});

child.on('error', (err) => {
  childExited = true;
  console.error(`[butler] 无法启动 Next.js：${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  childExited = true;
  if (signal !== null) {
    const bySignal = { SIGINT: 130, SIGTERM: 143 }[signal] ?? 1;
    process.exit(bySignal);
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (childExited) return;
    try {
      child.kill(signal);
    } catch {
      // 子进程可能刚好自己退出了；交给 exit 处理器收尾。
    }
  });
}

const ready = await waitForPage(url, WAIT_TIMEOUT_MS, () => childExited);

if (ready) {
  console.log('');
  console.log(`\u001b[32m▸ 已就绪\u001b[0m  ${url}`);
  openBrowser(url);
} else if (childExited) {
  // Next 自己退出时已经打印了原因，这里不重复刷屏。
} else {
  console.log('');
  console.log(`\u001b[33m▸ 等待超时\u001b[0m  仍未收到页面响应。请查看上方 Next.js 日志，或手动访问 ${url}`);
}
