/**
 * Python sidecar 适配器（实现 `DesktopBridgePort`）
 *
 * ★ 这里集中处理五件**踩过才知道**的事（对应方案 §9 的工程约束）：
 *
 *   ① **长驻进程**，不是每次 `python -c`
 *      桌面操作是连续多步；每次付 200—400ms 启动开销会迟滞到用户能感觉到。
 *   ② **请求 id + 超时**
 *      COM 调用可能卡死（Word 弹一个对话框就挂住）。没有超时，
 *      整个工具循环会永久等下去。
 *   ③ **stdout 只走协议，stderr 只走日志**
 *      Python 侧多 print 一行调试就污染协议 —— 所以这里按行解析并丢弃坏行。
 *   ④ **进程崩溃要能自愈**
 *      子进程死了就把在途请求全部 reject，下次调用重新拉起。
 *   ⑤ **显式 UTF-8**
 *      Windows 默认 GBK，中文窗口标题会变乱码（实测过）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  ConvertResult,
  DesktopBridgePort,
  DesktopCapabilities,
  DesktopWindow,
  ShotResult,
  UiaActionResult,
  UiaControl,
  UiaFindResult,
  UiaNode,
  UiaSetValueResult,
} from '../../core/desktop/port.js';

/** 把 bridge 回包里的控件描述转成强类型（形状不对返回 null，不猜） */
function toControl(raw: unknown): UiaControl | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const rect = o['rect'];
  const rectArr: [number, number, number, number] = Array.isArray(rect) && rect.length === 4
    ? [
        typeof rect[0] === 'number' ? rect[0] : 0,
        typeof rect[1] === 'number' ? rect[1] : 0,
        typeof rect[2] === 'number' ? rect[2] : 0,
        typeof rect[3] === 'number' ? rect[3] : 0,
      ]
    : [0, 0, 0, 0];
  const pats = o['patterns'];
  return {
    type: typeof o['type'] === 'string' ? o['type'] : '',
    name: typeof o['name'] === 'string' ? o['name'] : '',
    automationId: typeof o['automationId'] === 'string' ? o['automationId'] : '',
    rect: rectArr,
    ...(Array.isArray(pats) ? { patterns: pats.filter((p): p is string => typeof p === 'string') } : {}),
  };
}

function toNode(raw: unknown): UiaNode | null {
  const c = toControl(raw);
  if (c === null) return null;
  const o = raw as Record<string, unknown>;
  return {
    ...c,
    depth: typeof o['depth'] === 'number' ? o['depth'] : 0,
    className: typeof o['className'] === 'string' ? o['className'] : '',
  };
}

/** 协议回包 */
type BridgeResponse =
  | { readonly id: string | null; readonly ok: true; readonly result: unknown }
  | { readonly id: string | null; readonly ok: false; readonly error: string };

interface Pending {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface PythonBridgeOptions {
  /** Python 可执行文件（默认 `python`，可用 BUTLER_PYTHON 覆盖）*/
  readonly pythonExe?: string;
  /** 桥脚本路径 */
  readonly scriptPath: string;
  /** 默认超时（毫秒）。COM 转换会单独放宽 */
  readonly timeoutMs?: number;
  /** 记最近多少行 stderr 用于报错诊断 */
  readonly stderrKeep?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Office 转换可能几十秒（大文档 + 冷启动 Word）*/
const CONVERT_TIMEOUT_MS = 180_000;
const DEFAULT_STDERR_KEEP = 40;

export class PythonDesktopBridge implements DesktopBridgePort {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly stderrLines: string[] = [];
  private stdoutBuf = '';
  private closed = false;

  constructor(private readonly opts: PythonBridgeOptions) {}

  // ── 子进程生命周期 ──

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new Error('桌面桥已关闭');
    if (this.child !== null && !this.child.killed) return this.child;

    const python = this.opts.pythonExe ?? process.env['BUTLER_PYTHON'] ?? 'python';
    const child = spawn(python, [this.opts.scriptPath], {
      // 显式 UTF-8：Windows 默认 GBK
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      const keep = this.opts.stderrKeep ?? DEFAULT_STDERR_KEEP;
      for (const line of chunk.split('\n')) {
        if (line.trim().length === 0) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > keep) this.stderrLines.shift();
      }
    });

    child.on('error', (err) => {
      // 拉不起来（Python 不在 PATH）—— 在途请求全部失败，且不要无限重试
      this.failAll(new Error(`无法启动 Python 桌面桥（${python}）：${err.message}`));
      this.child = null;
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.failAll(
        new Error(
          `Python 桌面桥退出（code=${String(code)}, signal=${String(signal)}）` +
            this.stderrTail(),
        ),
      );
    });

    this.child = child;
    return child;
  }

  private stderrTail(): string {
    if (this.stderrLines.length === 0) return '';
    return `；最近日志：${this.stderrLines.slice(-5).join(' | ')}`;
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  // ── 协议 ──

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    // 按行切：最后一段可能不完整，留在缓冲里
    for (;;) {
      const nl = this.stdoutBuf.indexOf('\n');
      if (nl < 0) break;
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;

      let resp: BridgeResponse;
      try {
        resp = JSON.parse(line) as BridgeResponse;
      } catch {
        // ⚠️ 坏行**丢弃而不抛错**：Python 侧若混进一行调试输出，
        //    不该让整个通道失效（协议行仍会正常到来）
        continue;
      }

      const id = resp.id;
      if (id === null) continue;
      const p = this.pending.get(id);
      if (p === undefined) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);

      if (resp.ok) p.resolve(resp.result);
      else p.reject(new Error(resp.error));
    }
  }

  private call(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.ensureChild();
    const id = `r${++this.seq}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `桌面操作超时（${op}，${timeoutMs}ms）。COM 调用可能被弹窗卡住了` +
              this.stderrTail(),
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`, 'utf8');
    });
  }

  // ── 端口实现 ──

  async ping(): Promise<DesktopCapabilities> {
    const raw = await this.call('ping', {}, 15_000);
    if (typeof raw !== 'object' || raw === null) throw new Error('ping 返回形状异常');
    const o = raw as Record<string, unknown>;
    const caps = o['capabilities'];
    return {
      python: typeof o['python'] === 'string' ? o['python'] : '',
      platform: typeof o['platform'] === 'string' ? o['platform'] : '',
      capabilities:
        typeof caps === 'object' && caps !== null
          ? (caps as Record<string, boolean>)
          : {},
    };
  }

  async listWindows(limit?: number): Promise<readonly DesktopWindow[]> {
    const raw = await this.call('list_windows', limit !== undefined ? { limit } : {}, 20_000);
    if (typeof raw !== 'object' || raw === null) return [];
    const list = (raw as Record<string, unknown>)['windows'];
    if (!Array.isArray(list)) return [];
    const out: DesktopWindow[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      out.push({
        title: typeof r['title'] === 'string' ? r['title'] : '',
        className: typeof r['className'] === 'string' ? r['className'] : '',
        processId: typeof r['processId'] === 'number' ? r['processId'] : 0,
      });
    }
    return out;
  }

  async officeConvert(source: string, target: string): Promise<ConvertResult> {
    const raw = await this.call('office_convert', { source, target }, CONVERT_TIMEOUT_MS);
    if (typeof raw !== 'object' || raw === null) throw new Error('office_convert 返回形状异常');
    const o = raw as Record<string, unknown>;
    return {
      source: typeof o['source'] === 'string' ? o['source'] : source,
      target: typeof o['target'] === 'string' ? o['target'] : target,
      bytes: typeof o['bytes'] === 'number' ? o['bytes'] : 0,
    };
  }

  async screenshot(): Promise<ShotResult> {
    const raw = await this.call('screenshot', {}, 30_000);
    if (typeof raw !== 'object' || raw === null) throw new Error('screenshot 返回形状异常');
    const o = raw as Record<string, unknown>;
    return {
      path: typeof o['path'] === 'string' ? o['path'] : '',
      backend: typeof o['backend'] === 'string' ? o['backend'] : '',
      width: typeof o['width'] === 'number' ? o['width'] : 0,
      height: typeof o['height'] === 'number' ? o['height'] : 0,
    };
  }

  // ── UIA ──

  async uiaTree(window: string, depth?: number, max?: number): Promise<readonly UiaNode[]> {
    const args: Record<string, unknown> = { window };
    if (depth !== undefined) args['depth'] = depth;
    if (max !== undefined) args['max'] = max;
    const raw = await this.call('uia_tree', args, 30_000);
    if (typeof raw !== 'object' || raw === null) return [];
    const list = (raw as Record<string, unknown>)['controls'];
    if (!Array.isArray(list)) return [];
    const out: UiaNode[] = [];
    for (const item of list) {
      const n = toNode(item);
      if (n !== null) out.push(n);
    }
    return out;
  }

  async uiaFind(window: string, name: string, controlType?: string): Promise<UiaFindResult> {
    const args: Record<string, unknown> = { window, name };
    if (controlType !== undefined) args['controlType'] = controlType;
    const raw = await this.call('uia_find', args, 30_000);
    if (typeof raw !== 'object' || raw === null) return { count: 0, matches: [] };
    const o = raw as Record<string, unknown>;
    const list = o['matches'];
    const matches: UiaControl[] = [];
    if (Array.isArray(list)) {
      for (const item of list) {
        const c = toControl(item);
        if (c !== null) matches.push(c);
      }
    }
    return { count: typeof o['count'] === 'number' ? o['count'] : matches.length, matches };
  }

  async uiaAction(
    window: string,
    name: string,
    action: 'toggle' | 'select' | 'invoke' | 'expand' | 'collapse',
    controlType?: string,
  ): Promise<UiaActionResult> {
    const args: Record<string, unknown> = { window, name, action };
    if (controlType !== undefined) args['controlType'] = controlType;
    const raw = await this.call('uia_action', args, 45_000);
    if (typeof raw !== 'object' || raw === null) throw new Error('uia_action 返回形状异常');
    const o = raw as Record<string, unknown>;
    const control = toControl(o['control']);
    if (control === null) throw new Error('uia_action 未返回控件信息');
    const numOrBool = (v: unknown): number | boolean | null =>
      typeof v === 'number' || typeof v === 'boolean' ? v : null;
    return {
      action: typeof o['action'] === 'string' ? o['action'] : action,
      control,
      before: numOrBool(o['before']),
      after: numOrBool(o['after']),
      verified: typeof o['verified'] === 'boolean' ? o['verified'] : null,
    };
  }

  async uiaSetValue(window: string, name: string, value: string): Promise<UiaSetValueResult> {
    const raw = await this.call('uia_set_value', { window, name, value }, 30_000);
    if (typeof raw !== 'object' || raw === null) throw new Error('uia_set_value 返回形状异常');
    const o = raw as Record<string, unknown>;
    const control = toControl(o['control']);
    if (control === null) throw new Error('uia_set_value 未返回控件信息');
    return {
      control,
      before: typeof o['before'] === 'string' ? o['before'] : '',
      after: typeof o['after'] === 'string' ? o['after'] : '',
      verified: o['verified'] === true,
    };
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('桌面桥已关闭'));
    if (this.child !== null) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {
        // 关不掉就算了 —— 退出路径不该再抛错
      }
      this.child = null;
    }
  }

  /** 仅供测试/诊断：默认超时值 */
  static readonly DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
}
