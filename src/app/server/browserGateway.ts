/**
 * 浏览器本地网关
 *
 * ★ 为什么需要它：Next dev 对每个 API 请求有 ~45ms 固定开销（实测），
 *   而浏览器的输入（滚轮/鼠标）每秒几十次、画面每秒几十帧；
 *   全部走 Next 路由会被请求队列拖死。
 *   这里在进程内另起一个只监听 127.0.0.1 的极小 HTTP 服务：
 *   - POST /input  单条输入（走 CDP，实测 <2ms）
 *   - GET  /frames 二进制帧流（[u32 长度][u16 宽][u16 高][JPEG]）
 *   - GET  /health
 *   带随机 token，只允许本机持有 token 的页面访问。
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  activateTab,
  applyInput,
  browserStatus,
  closeTab,
  goBack,
  goForward,
  isBrowserError,
  keyInput,
  listDownloads,
  listTabs,
  navigate,
  newTab,
  pageInfo,
  readPage,
  readSelection,
  reload,
  resizeViewport,
  stopLoading,
  subscribeFrames,
} from './browserSession.js';

/** 网关协议版本：改接口时 +1，热重载后会重建旧服务。 */
const GATEWAY_VERSION = 2;

interface GatewayState {
  readonly server: Server;
  readonly token: string;
  readonly url: string;
  readonly version: number;
}

const GATEWAY_KEY = Symbol.for('butler.browser.gateway');
type GatewayGlobal = typeof globalThis & { [GATEWAY_KEY]?: GatewayState | null };

function getGateway(): GatewayState | null {
  return (globalThis as GatewayGlobal)[GATEWAY_KEY] ?? null;
}

function setGateway(next: GatewayState | null): void {
  (globalThis as GatewayGlobal)[GATEWAY_KEY] = next;
}

function cors(res: ServerResponse, req: IncomingMessage): void {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-butler-gateway-token');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['x-butler-gateway-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader === token) return true;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return url.searchParams.get('token') === token;
}

/** 读一个小 JSON 请求体（输入事件很小，限制 64KB）。 */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(text);
}

function framePacket(frame: { width: number; height: number; data: string }): Buffer {
  const jpeg = Buffer.from(frame.data, 'base64');
  const head = Buffer.alloc(8);
  head.writeUInt16LE(frame.width, 0);
  head.writeUInt16LE(frame.height, 2);
  head.writeUInt32LE(jpeg.length, 4);
  return Buffer.concat([head, jpeg]);
}

/**
 * 把一次浏览器操作分发到会话层。
 *
 * ★ 走网关而不是 Next 路由：网关没有 Next dev 的每请求开销（实测 45ms → 3ms），
 *   关标签、导航、读页面在交互里都要求"立刻有反应"。
 */
async function callRpc(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case 'state': {
      const status = browserStatus();
      if (!status.running) return { ok: true, running: false, executable: null };
      const info = await pageInfo();
      return { ok: true, running: true, executable: status.executable, ...info };
    }
    case 'tabs': {
      const tabs = await listTabs();
      return { ok: true, tabs };
    }
    case 'navigate':
      return { ok: true, ...(await navigate(String(args['input'] ?? ''))) };
    case 'action': {
      const action = String(args['action'] ?? '');
      if (action === 'back') await goBack();
      else if (action === 'forward') await goForward();
      else if (action === 'reload') await reload();
      else if (action === 'stop') await stopLoading();
      else throw new Error('未知动作');
      return { ok: true };
    }
    case 'tab': {
      const action = String(args['action'] ?? '');
      if (action === 'new') return { ok: true, ...(await newTab()) };
      if (action === 'activate') return { ok: await activateTab(String(args['id'] ?? '')) };
      if (action === 'close') {
        await closeTab(String(args['id'] ?? ''));
        return { ok: true };
      }
      throw new Error('未知标签动作');
    }
    case 'read':
      return { ok: true, ...(await readPage()) };
    case 'selection':
      return { ok: true, text: await readSelection() };
    case 'downloads':
      return { ok: true, items: await listDownloads() };
    case 'resize': {
      const viewport = await resizeViewport(Number(args['width']), Number(args['height']));
      return { ok: true, ...viewport };
    }
    case 'input':
      await applyInput(args);
      return { ok: true };
    case 'key':
      await keyInput(args as never);
      return { ok: true };
    default:
      throw new Error('未知操作');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  cors(res, req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!authorized(req, token)) {
    writeJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/rpc') {
    try {
      const payload = (await readJson(req)) as { op?: unknown; args?: unknown };
      const op = String(payload.op ?? '');
      const args =
        typeof payload.args === 'object' && payload.args !== null
          ? (payload.args as Record<string, unknown>)
          : {};
      const result = await callRpc(op, args);
      writeJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'rpc failed';
      const code = isBrowserError(err) ? err.code : 'error';
      writeJson(res, isBrowserError(err) && err.code === 'not_started' ? 409 : 400, { error: message, code });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/input') {
    try {
      const payload = await readJson(req);
      await applyInput(payload as Record<string, unknown>);
      writeJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'input failed';
      const code = isBrowserError(err) ? err.code : 'error';
      writeJson(res, isBrowserError(err) && err.code === 'not_started' ? 409 : 400, { error: message, code });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/frames') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const unsubscribe = subscribeFrames((frame) => {
      // 客户端太慢时丢帧：宁可少一帧，也不要累积延迟
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > 4 * 1024 * 1024) return;
      res.write(framePacket(frame));
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(Buffer.alloc(0));
    }, 15_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return;
  }

  writeJson(res, 404, { error: 'not found' });
}

/** 启动（或复用）网关。监听随机端口，只绑 127.0.0.1。 */
export async function ensureBrowserGateway(): Promise<{ url: string; token: string }> {
  const existing = getGateway();
  if (existing !== null && existing.version === GATEWAY_VERSION) {
    return { url: existing.url, token: existing.token };
  }
  if (existing !== null) {
    // dev 热重载后旧网关没有新接口：关掉重建，别让 UI 一直 404 回退
    setGateway(null);
    existing.server.close();
  }

  const token = randomBytes(24).toString('hex');
  const server = createServer((req, res) => {
    void handle(req, res, token).catch((err: unknown) => {
      if (!res.headersSent) writeJson(res, 500, { error: err instanceof Error ? err.message : 'gateway error' });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('网关启动失败');
  }
  const state: GatewayState = {
    server,
    token,
    url: `http://127.0.0.1:${address.port}`,
    version: GATEWAY_VERSION,
  };
  setGateway(state);
  return { url: state.url, token: state.token };
}

export function closeBrowserGateway(): void {
  const state = getGateway();
  if (state === null) return;
  setGateway(null);
  state.server.close();
}
