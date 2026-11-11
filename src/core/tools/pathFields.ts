/**
 * 工具的「路径参数」映射 —— 守卫、任务、界面三方共用
 *
 * ★ 为什么抽出来：
 *   同一份映射此前散在三处（会话守卫、任务守卫、界面高亮），
 *   任何一处漏了某个工具，就会出现"守卫认为它不碰文件，界面也不知道它在动哪个文件"。
 *   把"哪个参数是路径"收敛成一个事实来源，漏一个只改一处。
 *
 * ★ 读与写的区别是有意的：
 *   读路径只用于"能不能看"，写路径决定"能不能改 + 是否进回收站/高亮为写入"。
 */

/** 只读工具的路径参数。 */
export const READ_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['path'],
  list_dir: ['path'],
  stat_path: ['path'],
  grep: ['path'],
  glob: ['path'],
};

/**
 * 写类工具的路径参数。
 *
 * ⚠️ 这里每一条都能把文件写到工作区外：
 *   · `apply_patch` —— 按 path 直接改任意文本文件（`.ssh\authorized_keys` 就是一条）
 *   · `file_op`     —— mkdir/move/remove 三种动作都带路径
 *   · `desktop_act` —— `action: 'convert_office'` 带 source / target，而且它是 `normal` 档
 */
export const WRITE_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  write_file: ['path'],
  make_dir: ['path'],
  move_path: ['from', 'to'],
  remove_path: ['path'],
  apply_patch: ['path'],
  file_op: ['path', 'from', 'to'],
  desktop_office_convert: ['source', 'target'],
  desktop_act: ['source', 'target'],
};

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(WRITE_PATH_FIELDS));

export interface ToolPathFields {
  /** 这次调用真正会读的路径 */
  readonly reads: readonly string[];
  /** 这次调用真正会写的路径（含目录） */
  readonly writes: readonly string[];
}

function stringArg(args: unknown, field: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function actionOf(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)['action'];
  return typeof value === 'string' ? value : null;
}

/**
 * 取某次工具调用实际用到的路径参数。
 *
 * ★ 动作相关的工具只看**这次真正用到的字段**：
 *   `file_op` 的 `move` 只有 from/to，如果按整张表取，会把缺省字段当成路径；
 *   `desktop_act` 只有 `convert_office` 才碰文件，其它动作（点击/滚动）不该被当成写文件。
 */
export function pathFieldsOf(toolName: string, args: unknown): ToolPathFields {
  const reads: string[] = [];
  for (const field of READ_PATH_FIELDS[toolName] ?? []) {
    const v = stringArg(args, field);
    if (v !== null) reads.push(v);
  }

  const writeFields = WRITE_PATH_FIELDS[toolName];
  if (writeFields === undefined) return { reads, writes: [] };

  const action = actionOf(args);

  // `file_op`：三种动作各自的字段
  if (toolName === 'file_op') {
    const used =
      action === 'move'
        ? ['from', 'to']
        : action === 'mkdir' || action === 'remove'
          ? ['path']
          : writeFields;
    return {
      reads,
      writes: used.map((f) => stringArg(args, f)).filter((v): v is string => v !== null),
    };
  }

  // `desktop_act`：只有 convert_office 涉及文件
  if (toolName === 'desktop_act') {
    if (action !== 'convert_office') return { reads, writes: [] };
    return {
      reads,
      writes: writeFields.map((f) => stringArg(args, f)).filter((v): v is string => v !== null),
    };
  }

  return {
    reads,
    writes: writeFields.map((f) => stringArg(args, f)).filter((v): v is string => v !== null),
  };
}

/** 给界面用：从工具名和参数猜"这次动的是哪个文件"（拿不到就 null）。 */
export function primaryPathOf(toolName: string, args: unknown): { path: string; writing: boolean } | null {
  const fields = pathFieldsOf(toolName, args);
  const write = fields.writes[0];
  if (write !== undefined) return { path: write, writing: true };
  const read = fields.reads[0];
  if (read !== undefined) return { path: read, writing: false };
  return null;
}
