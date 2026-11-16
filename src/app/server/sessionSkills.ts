/**
 * 每个会话启用的技能 id。
 *
 * ★ 与 session settings 分开存：事件流只负责对话状态，
 *   技能启用属于 UI 选择，放在 sidecar 里避免给 ChatSession 增加迁移负担。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface Store {
  readonly version: 1;
  readonly bySession: Readonly<Record<string, readonly string[]>>;
}

function fileOf(dataDir: string): string {
  return join(dataDir, 'session-skills.json');
}

async function load(dataDir: string): Promise<Store> {
  try {
    const text = await readFile(fileOf(dataDir), 'utf8');
    const parsed = JSON.parse(text) as { bySession?: unknown };
    const raw = parsed.bySession;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { version: 1, bySession: {} };
    }
    const bySession: Record<string, string[]> = {};
    for (const [id, ids] of Object.entries(raw)) {
      if (Array.isArray(ids)) {
        bySession[id] = [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
      }
    }
    return { version: 1, bySession };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bySession: {} };
    throw err;
  }
}

async function save(dataDir: string, store: Store): Promise<void> {
  const target = fileOf(dataDir);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

export async function loadSessionSkills(
  dataDir: string,
  sessionId: string,
): Promise<readonly string[]> {
  const store = await load(dataDir);
  return store.bySession[sessionId] ?? [];
}

export async function saveSessionSkills(
  dataDir: string,
  sessionId: string,
  ids: readonly string[],
): Promise<readonly string[]> {
  const store = await load(dataDir);
  const clean = [...new Set(ids.map((x) => x.trim()).filter((x) => x.length > 0))];
  const bySession = { ...store.bySession };
  if (clean.length === 0) delete bySession[sessionId];
  else bySession[sessionId] = clean;
  await save(dataDir, { version: 1, bySession });
  return clean;
}
