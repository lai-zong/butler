/**
 * 会话工作区的真实校验（app 层，必须碰磁盘）
 *
 * ★ 为什么校验放在这里而不是 PATCH 解析器：
 *   “存在 / 是目录 / realpath 归一 / 不是受保护目录”都必须访问磁盘，
 *   而解析器是同步纯函数。分开的好处是解析器可以独立单测非法类型，
 *   这里则用临时目录做真实文件系统验收。
 *
 * ★ 四条硬规则（用户要求）：
 *   ① 必须是绝对路径；
 *   ② 必须真实存在且是目录；
 *   ③ 规范化 realpath（符号链接/`..` 都归一到真实路径）；
 *   ④ 不能是 `.butler-data` 等受保护目录，也不能是 `.env.local` 文件。
 *
 * ⚠️ 这里**不是**沙箱：它只校验“会话根目录选在哪”。
 *    工具执行时的路径限制由 `sessionPathGuard` + `NodeFileSystem` 负责。
 */

import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { appDataDir, appInstallRoot } from './sessionScope.js';

export interface WorkspaceRoots {
  /** 系统数据目录（默认 `.butler-data`）。 */
  readonly dataDir: string;
  /** 应用根目录；用于保护它的 `.env.local`、`config/` 与默认 `.butler-data`。 */
  readonly appRoot: string;
}

export class SessionWorkspaceError extends Error {
  override readonly name = 'SessionWorkspaceError';
}

/** target 是否等于 root 或位于 root 之内（按解析后的绝对路径判断）。 */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * 解析路径的**真实路径**；目标还不存在时，解析最近的已存在祖先，
 * 再把剩余路径拼回去。
 *
 * ★ 为什么需要它：Windows junction / 符号链接可以让
 *   `workspace\link\secret.txt` 字面上在工作区内，真实路径却在工作区外。
 *   只做字面 `resolve` 的守卫挡不住这种逃逸。
 *
 * ⚠️ 这是路径守卫的一部分，不是完整沙箱；检查与执行之间仍有 TOCTOU 窗口。
 */
export async function resolveRealPathForGuard(absolute: string): Promise<string> {
  const normalized = resolve(absolute);
  const suffix: string[] = [];
  let current = normalized;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await realpath(current);
      return suffix.length === 0 ? real : resolve(real, ...suffix.slice().reverse());
    } catch {
      // 当前段不存在：上溯到父目录继续找
    }
    const parent = dirname(current);
    if (parent === current) break;
    suffix.push(basename(current));
    current = parent;
  }
  return normalized;
}

function rootsOf(input?: Partial<WorkspaceRoots>): WorkspaceRoots {
  return {
    dataDir: resolve(input?.dataDir ?? appDataDir()),
    // 应用根用于保护 config/、.env.local，必须与“默认工作区”分开；
    // 默认工作区现在是 APP_ROOT/workplace，不能拿来当 appRoot。
    appRoot: resolve(input?.appRoot ?? appInstallRoot()),
  };
}

/**
 * 校验并归一化一个会话工作区。
 *
 * @throws SessionWorkspaceError 带**可直接展示给用户**的中文原因。
 */
export async function assertSessionWorkspace(
  raw: string,
  roots?: Partial<WorkspaceRoots>,
): Promise<string> {
  if (typeof raw !== 'string') {
    throw new SessionWorkspaceError('工作区必须是字符串路径');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SessionWorkspaceError('工作区不能为空；要跟随应用默认请留空或传 null');
  }
  if (!isAbsolute(trimmed)) {
    throw new SessionWorkspaceError(`工作区必须是绝对路径：${trimmed}`);
  }

  const { dataDir, appRoot } = rootsOf(roots);
  const resolved = resolve(trimmed);

  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new SessionWorkspaceError(`工作区不存在：${resolved}`);
  }
  if (!info.isDirectory()) {
    throw new SessionWorkspaceError(`工作区不是目录：${resolved}`);
  }

  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    // stat 成功但 realpath 失败（权限/竞态）：按不存在处理，不猜
    throw new SessionWorkspaceError(`无法解析工作区真实路径：${resolved}`);
  }

  /**
   * 受保护目录：系统数据目录、应用根下的默认 `.butler-data`、应用 `config/`。
   *
   * ★ `config/AGENTS.md` 是产品级全局规则；如果会话工具能改写它，
   *   就等于绕过了全局 AGENTS 注入。因此整个 `config/` 目录都不开放。
   *
   * ⚠️ 同时比较 realpath 与字面 resolve：
   *    配置目录可能是符号链接，只比较一种写法会漏。
   */
  const protectedDirs = new Set<string>([
    dataDir,
    join(appRoot, '.butler-data'),
    join(appRoot, 'config'),
  ]);
  const realDataDir = await realpath(dataDir).catch(() => null);
  if (realDataDir !== null) protectedDirs.add(realDataDir);
  const realConfig = await realpath(join(appRoot, 'config')).catch(() => null);
  if (realConfig !== null) protectedDirs.add(realConfig);
  for (const protectedDir of protectedDirs) {
    if (isPathInside(protectedDir, real) || isPathInside(protectedDir, resolved)) {
      throw new SessionWorkspaceError(
        `工作区不能是受保护目录（.butler-data / config）或其内部路径：${real}`,
      );
    }
  }

  if (basename(real) === '.env.local' || basename(resolved) === '.env.local') {
    throw new SessionWorkspaceError('工作区不能设为 .env.local（密钥文件）');
  }
  if (isPathInside(join(appRoot, '.env.local'), real)) {
    throw new SessionWorkspaceError('工作区不能设为 .env.local（密钥文件）');
  }

  return real;
}

/**
 * 工具作用域里始终要拒绝的路径。
 *
 * ★ 即使 `permission: 'full'`，这些路径也**不**开放：
 *   full 表示“工具档位放开”，不表示“系统内部数据/密钥/全局规则可以给模型改”。
 *
 * ★ `config/` 整目录保护：至少覆盖 `config/AGENTS.md`，
 *   防止会话工具改写产品级全局规则来绕过注入。
 */
export function protectedSessionPaths(
  workspace: string,
  roots?: Partial<WorkspaceRoots>,
): readonly string[] {
  const { dataDir, appRoot } = rootsOf(roots);
  const unique = new Set<string>([
    resolve(dataDir),
    join(appRoot, '.butler-data'),
    join(appRoot, '.env.local'),
    join(appRoot, 'config'),
    join(resolve(workspace), '.env.local'),
  ]);
  return [...unique];
}
