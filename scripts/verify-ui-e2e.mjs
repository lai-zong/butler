/**
 * 一键 UI 回归：临时数据 → 真实 Next → 真实 Edge/CDP → 点击断言 → 全清理
 *
 * 用法：pnpm verify:ui
 * 前置：pnpm build（本脚本检查 .next/BUILD_ID）
 *
 * ⚠️ 只使用临时 BUTLER_DATA_DIR；不碰真实 .butler-data。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const NEXT_BIN = resolve(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const BUILD_ID = resolve(ROOT, '.next', 'BUILD_ID');
const TSX_CLI = resolve(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SEED = resolve(ROOT, 'scripts', 'seed-ui-fixture.ts');
const CHECKS = resolve(ROOT, 'scripts', 'cdp-ui-check.mjs');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[verify:ui] ${msg}`);

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      s.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(base, child, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`next start 提前退出，exitCode=${String(child.exitCode)}`);
    }
    try {
      const res = await fetch(`${base}/api/status`, { signal: globalThis.AbortSignal.timeout(2_000) });
      if (res.status === 200) return;
    } catch {
      // 未就绪
    }
    await delay(350);
  }
  throw new Error(`等待 ${base}/api/status 超时`);
}

async function waitForCdp(cdpBase, host, child, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Edge 提前退出，exitCode=${String(child.exitCode)}`);
    }
    try {
      const targets = await (await fetch(`${cdpBase}/json/list`, {
        signal: globalThis.AbortSignal.timeout(2_000),
      })).json();
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes(host))) {
        return;
      }
    } catch {
      // 未就绪
    }
    await delay(250);
  }
  throw new Error(`等待 Edge CDP 页面超时（${cdpBase}）`);
}

async function stopTree(child) {
  if (child === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await Promise.race([
        new Promise((resolveClose) => killer.once('close', resolveClose)),
        delay(5_000),
      ]);
    } catch {
      child.kill();
    }
  } else {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(5_000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function main() {
  if (!existsSync(BUILD_ID)) {
    throw new Error('缺少 .next/BUILD_ID；请先运行 pnpm build');
  }
  if (!existsSync(NEXT_BIN)) throw new Error(`找不到 next：${NEXT_BIN}`);
  if (!existsSync(TSX_CLI)) throw new Error(`找不到 tsx：${TSX_CLI}`);
  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (edge === undefined) throw new Error('找不到 Microsoft Edge');

  const dir = await mkdtemp(join(tmpdir(), 'butler-ui-e2e-'));
  const profile = join(dir, 'edge-profile');
  const outPath = join(dir, 'next.out.log');
  const errPath = join(dir, 'next.err.log');
  let nextChild;
  let edgeChild;
  let outFd;
  let errFd;
  let failure;

  try {
    const seed = spawnSync(process.execPath, [TSX_CLI, SEED, dir], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: 'inherit',
    });
    if (seed.status !== 0) {
      throw new Error(`种子数据失败，exit=${String(seed.status)}`);
    }

    const port = await freePort();
    const cdpPort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const cdpBase = `http://127.0.0.1:${cdpPort}`;
    outFd = await open(outPath, 'w');
    errFd = await open(errPath, 'w');

    nextChild = spawn(
      process.execPath,
      [NEXT_BIN, 'start', '-H', '127.0.0.1', '-p', String(port)],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          BUTLER_DATA_DIR: dir,
          BUTLER_USER_ID: 'ui_user',
          MCP_CONFIG_PATH: join(dir, 'mcp.json'),
          BUTLER_NO_OPEN: '1',
          NEXT_TELEMETRY_DISABLED: '1',
        },
        stdio: ['ignore', outFd.fd, errFd.fd],
        windowsHide: true,
      },
    );
    log(`next start ${base}`);
    await waitForServer(base, nextChild);

    edgeChild = spawn(
      edge,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--remote-allow-origins=*',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profile}`,
        '--window-size=1440,900',
        `${base}/#/console/memory`,
      ],
      { cwd: ROOT, stdio: 'ignore', windowsHide: true },
    );
    log(`Edge CDP ${cdpBase}`);
    await waitForCdp(cdpBase, new URL(base).host, edgeChild);

    const checks = spawnSync(process.execPath, [CHECKS], {
      cwd: ROOT,
      env: {
        ...process.env,
        UI_BASE_URL: base,
        UI_CDP_URL: cdpBase,
      },
      stdio: 'inherit',
    });
    if (checks.status !== 0) {
      throw new Error(`UI 点击断言失败，exit=${String(checks.status)}`);
    }
    log('all UI checks passed');
  } catch (err) {
    failure = err;
  } finally {
    await stopTree(edgeChild);
    await stopTree(nextChild);
    try {
      await outFd?.close();
      await errFd?.close();
    } catch {
      // ignore
    }

    if (failure !== undefined) {
      console.error(`[verify:ui] FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
      for (const [label, path] of [['stdout', outPath], ['stderr', errPath]]) {
        try {
          const text = await readFile(path, 'utf8');
          const tail = text.trim().split(/\r?\n/).slice(-30).join('\n');
          if (tail.length > 0) console.error(`[verify:ui] next ${label} tail:\n${tail}`);
        } catch {
          // no log
        }
      }
      process.exitCode = 1;
    } else {
      log('all processes stopped; temp data cleaned');
      process.exitCode = 0;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[verify:ui] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
