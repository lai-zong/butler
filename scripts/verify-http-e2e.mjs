/**
 * 真实 HTTP E2E（可重复执行）
 *
 * 为什么需要它：
 *   路由单测用 fake runtime，集成测试用进程内真实 runtime；
 *   两者都没有验证“实际 Next 进程 + HTTP + 临时数据目录”这一层。
 *
 * 本脚本：
 *   ① 建临时 BUTLER_DATA_DIR（绝不碰项目 .butler-data）
 *   ② 从现有 .next 启动 next start（要求先 pnpm build）
 *   ③ 走真实 HTTP：status → observation → demo → operations → 404 边界
 *   ④ 无论成功失败都杀进程、删临时目录
 *
 * 用法：pnpm verify:http
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const NEXT_BIN = resolve(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const BUILD_ID = resolve(ROOT, '.next', 'BUILD_ID');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`[verify:http] ${msg}`);
}

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

async function waitForServer(base, child, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`next start 提前退出，exitCode=${String(child.exitCode)}`);
    }
    try {
      const res = await fetch(`${base}/api/status`, {
        signal: globalThis.AbortSignal.timeout(2_000),
      });
      if (res.status === 200) return;
    } catch {
      // 未就绪，继续等
    }
    await delay(400);
  }
  throw new Error(`等待 ${base}/api/status 超时（${timeoutMs}ms）`);
}

async function request(base, path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, json, text };
}

async function post(base, path, body) {
  return request(base, path, { method: 'POST', body: JSON.stringify(body) });
}

/** multipart 上传真实文件（不是把文本塞进 JSON）。 */
async function uploadFile(base, path, filePath, mime) {
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), basename(filePath));
  const res = await fetch(`${base}${path}`, { method: 'POST', body: form });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, json, text };
}

async function stopServer(child, fds) {
  if (child !== undefined && child.exitCode === null) {
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        await Promise.race([once(killer, 'close'), delay(5_000)]);
      } catch {
        child.kill();
      }
    } else {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  for (const fd of fds) {
    try {
      await fd.close();
    } catch {
      // 已关闭
    }
  }
}

async function main() {
  if (!existsSync(BUILD_ID)) {
    throw new Error('找不到 .next/BUILD_ID；请先运行 pnpm build，再运行 pnpm verify:http');
  }
  if (!existsSync(NEXT_BIN)) {
    throw new Error(`找不到 next 可执行文件：${NEXT_BIN}`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'butler-http-e2e-'));
  const outPath = join(dir, 'server.out.log');
  const errPath = join(dir, 'server.err.log');
  const outFd = await open(outPath, 'w');
  const errFd = await open(errPath, 'w');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    BUTLER_DATA_DIR: dir,
    BUTLER_USER_ID: 'e2e_http',
    MCP_CONFIG_PATH: join(dir, 'mcp.json'),
    BUTLER_NO_OPEN: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  // 预置一个 disabled MCP server：导出/导入测试不依赖外部进程。
  await writeFile(
    join(dir, 'mcp.json'),
    JSON.stringify({
      servers: [
        {
          id: 'e2e-disabled',
          name: 'E2E Disabled',
          transport: 'stdio',
          command: 'node',
          args: [],
          enabled: false,
        },
      ],
    }),
    'utf8',
  );

  log(`starting next on ${base} with temp data ${dir}`);
  const child = spawn(
    process.execPath,
    [NEXT_BIN, 'start', '-H', '127.0.0.1', '-p', String(port)],
    {
      cwd: ROOT,
      env,
      stdio: ['ignore', outFd.fd, errFd.fd],
      windowsHide: true,
    },
  );

  let failure;
  try {
    await waitForServer(base, child);
    log('server ready');

    // ① 状态
    const status = await request(base, '/api/status');
    assert.equal(status.res.status, 200, `status 应为 200，实际 ${status.res.status}`);
    assert.equal(status.json?.ok, true, 'status.ok 应为 true');

    // ①b 模型 provider 状态（不返回 Key）
    const modelStatus = await request(base, '/api/model');
    assert.equal(modelStatus.res.status, 200, 'GET /api/model 应 200');
    assert.equal(modelStatus.json?.current?.provider, 'deepseek', '默认 provider 应为 deepseek');
    assert.equal(modelStatus.json?.envLocked, false, '未设置 MODEL_PROVIDER 时不应锁定');
    assert.equal(Array.isArray(modelStatus.json?.providers), true, 'providers 应为数组');
    assert.ok(
      (modelStatus.json?.providers ?? []).some((p) => p.id === 'deepseek'),
      'provider 列表缺少 deepseek',
    );
    assert.ok(
      !modelStatus.text.includes('DEEPSEEK_API_KEY='),
      'provider 状态不能回显 Key',
    );

    // ② 默认未同意；未同意时 demo 应 409
    const before = await request(base, '/api/observation');
    assert.equal(before.res.status, 200);
    assert.equal(before.json?.granted, false, '默认应为未同意');
    const denied = await post(base, '/api/activity/demo', {
      profile: 'office-dev',
      days: 1,
    });
    assert.equal(denied.res.status, 409, `未同意 demo 应为 409，实际 ${denied.res.status}`);

    // ③ 显式同意；导入 3 天演示数据
    const grant = await post(base, '/api/observation', { granted: true });
    assert.equal(grant.res.status, 200);
    assert.equal(grant.json?.granted, true);

    const demo = await post(base, '/api/activity/demo', {
      profile: 'office-dev',
      days: 3,
    });
    assert.equal(demo.res.status, 200, `demo 应为 200，实际 ${demo.res.status}`);
    assert.equal(demo.json?.source, 'demo');
    assert.ok((demo.json?.recorded ?? 0) > 0, 'demo.recorded 应 > 0');
    assert.equal(demo.json.recorded, demo.json.generated, 'recorded 应等于 generated');

    const activity = await request(base, '/api/activity');
    assert.equal(activity.res.status, 200);
    assert.ok((activity.json?.aggregates?.length ?? 0) > 0, '应产生聚合');
    assert.ok((activity.json?.raw?.length ?? 0) > 0, '演示原始记录应存在');

    // ④ 真实操作记忆写入 + 读取
    const op = await post(base, '/api/operations', {
      kind: 'preference',
      content: 'E2E 喜欢简短回复',
      taskLabel: '写邮件',
    });
    assert.equal(op.res.status, 200, `operations 应为 200，实际 ${op.res.status}`);
    const opId = op.json?.operation?.id;
    assert.ok(typeof opId === 'string' && opId.length > 0, '应返回 operation.id');

    const ops = await request(base, '/api/operations?kind=preference');
    assert.equal(ops.res.status, 200);
    assert.ok(
      (ops.json?.operations ?? []).some((o) => o.content === 'E2E 喜欢简短回复'),
      'GET operations 应能读到刚写入的偏好',
    );

    // 凭证内容必须拒绝
    const badOp = await post(base, '/api/operations', {
      kind: 'preference',
      content: 'api_key=sk-123456789012345678901234567890',
      taskLabel: '测试',
    });
    assert.equal(badOp.res.status, 400, '含凭证的 operation 应 400');

    // ⑤ 404 / 400 边界
    const badFormat = await request(
      base,
      '/api/artifacts/missing/download?format=txt',
    );
    assert.equal(badFormat.res.status, 400, '不支持的格式应 400');

    const missingArtifact = await request(
      base,
      '/api/artifacts/missing/download?format=csv',
    );
    assert.equal(missingArtifact.res.status, 404, '不存在的产出物应 404');

    const savedCredential = await post(base, '/api/credentials', {
      name: 'e2e_http_token',
      secret: 'ghp_e2e_should_not_leak_123456',
    });
    assert.equal(savedCredential.res.status, 201, '凭证应能加密保存');
    assert.ok(
      !savedCredential.text.includes('ghp_e2e_should_not_leak_123456'),
      '保存响应不能回显凭证内容',
    );
    const listedCredentials = await request(base, '/api/credentials');
    assert.equal(listedCredentials.res.status, 200);
    assert.ok(
      !listedCredentials.text.includes('ghp_e2e_should_not_leak_123456'),
      '列表不能返回凭证内容',
    );
    const credentialId = savedCredential.json?.credential?.id;
    assert.equal(typeof credentialId, 'string', '保存响应缺 credential.id');
    const deleted = await request(base, `/api/credentials/${credentialId}`, {
      method: 'DELETE',
    });
    assert.equal(deleted.res.status, 200, '凭证应能删除');

    const savedDoc = await post(base, '/api/documents', {
      name: 'e2e-报告.txt',
      text: '低密度脂蛋白 LDL 为 3.8 mmol/L，建议三个月后复查。',
    });
    assert.equal(savedDoc.res.status, 201, '文档应能入库');
    const docId = savedDoc.json?.document?.id;
    assert.equal(typeof docId, 'string', '文档响应缺 id');
    const foundDoc = await request(base, '/api/documents?q=LDL');
    assert.equal(foundDoc.res.status, 200);
    assert.ok(foundDoc.text.includes('3.8'), '文档检索应返回正确片段');
    const deletedDoc = await request(base, `/api/documents/${docId}`, { method: 'DELETE' });
    assert.equal(deletedDoc.res.status, 200, '文档应能删除');

    /**
     * ★ 真实文件上传 E2E：PDF / DOCX / XLSX。
     *   - 不是把文本塞进 /api/documents；
     *   - 走 multipart → /api/attachments/extract → 文本 → 文档库 → 检索。
     */
    const fixtureDir = join(dir, 'fixtures');
    const fixtureScript = resolve(ROOT, 'scripts', 'make-doc-fixtures.py');
    const gen = spawnSync(process.env['PYTHON'] ?? 'python', [fixtureScript, fixtureDir], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(gen.status, 0, `生成 PDF/DOCX/XLSX fixture 失败：${gen.stderr ?? ''}`);

    const uploads = [
      {
        file: join(fixtureDir, 'sample.pdf'),
        mime: 'application/pdf',
        expect: ['LDL', '3.8'],
      },
      {
        file: join(fixtureDir, 'sample.docx'),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        expect: ['验收', '三十天'],
      },
      {
        file: join(fixtureDir, 'sample.xlsx'),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        expect: ['产品', '120'],
      },
    ];

    for (const u of uploads) {
      const extracted = await uploadFile(base, '/api/attachments/extract', u.file, u.mime);
      assert.equal(
        extracted.res.status,
        200,
        `${basename(u.file)} 提取应 200，实际 ${extracted.res.status}：${extracted.text.slice(0, 200)}`,
      );
      const content = extracted.json?.text;
      assert.equal(typeof content, 'string', `${basename(u.file)} 未返回 text`);
      for (const want of u.expect) {
        assert.ok(
          content.includes(want),
          `${basename(u.file)} 提取文本缺少「${want}」：${content.slice(0, 200)}`,
        );
      }

      const name = `e2e-${basename(u.file)}`;
      const saved = await post(base, '/api/documents', { name, text: content });
      assert.equal(saved.res.status, 201, `${name} 应能入库`);
      const savedId = saved.json?.document?.id;
      assert.equal(typeof savedId, 'string', `${name} 入库响应缺 id`);
      const query = u.expect[0];
      const found = await request(base, `/api/documents?q=${encodeURIComponent(query)}`);
      assert.equal(found.res.status, 200);
      assert.ok(found.text.includes(u.expect[0]), `${name} 检索应命中「${query}」`);
      const removed = await request(base, `/api/documents/${savedId}`, { method: 'DELETE' });
      assert.equal(removed.res.status, 200, `${name} 应能删除`);
    }

    /**
     * 真实 provider 验证：
     *   · DeepSeek 用 .env.local 的 Key 发一次非流式调用；
     *   · 本机 Ollama 若可达，也发一次；不可达就明确跳过，不伪装通过。
     */
    const providerRows = modelStatus.json?.providers ?? [];
    const deepseek = providerRows.find((p) => p.id === 'deepseek');
    if (deepseek?.configured === true) {
      const validated = await post(base, '/api/model', {
        action: 'validate',
        provider: 'deepseek',
      });
      assert.equal(
        validated.res.status,
        200,
        `DeepSeek 验证应 200，实际 ${validated.res.status}：${validated.text.slice(0, 200)}`,
      );
      assert.equal(validated.json?.ok, true, 'DeepSeek 验证 ok 应为 true');
      log(`deepseek validated: ${validated.json?.model} ${validated.json?.latencyMs}ms`);
    } else {
      log('deepseek 未配置，跳过真实 Key 验证');
    }

    const ollama = providerRows.find((p) => p.id === 'ollama');
    if (ollama?.configured === true) {
      const validated = await post(base, '/api/model', {
        action: 'validate',
        provider: 'ollama',
      });
      assert.equal(
        validated.res.status,
        200,
        `Ollama 验证应 200，实际 ${validated.res.status}：${validated.text.slice(0, 200)}`,
      );
      assert.equal(validated.json?.ok, true, 'Ollama 验证 ok 应为 true');
      log(`ollama validated: ${validated.json?.model} ${validated.json?.latencyMs}ms`);
    } else {
      log('Ollama 未检测到端点，跳过本地模型验证');
    }

    const missingVerdict = await post(base, '/api/memory/verdict', {
      winnerId: 'missing-a',
      loserId: 'missing-b',
    });
    assert.equal(missingVerdict.res.status, 404, '不存在的裁决应 404');

    // ⑥ MCP 配置真实导出/导入：导入会重建运行时，放在最后。
    const exported = await request(base, '/api/mcp/export');
    assert.equal(exported.res.status, 200, 'MCP 导出应 200');
    assert.equal(exported.json?.schema, 'butler-mcp-config@1');
    assert.equal(exported.json?.envOmitted, true);
    assert.ok(
      (exported.json?.servers ?? []).some((s) => s.id === 'e2e-disabled'),
      'MCP 导出缺少预置 server',
    );
    assert.ok(
      !JSON.stringify(exported.json).includes('API_TOKEN'),
      'MCP 导出不应含 env 值',
    );
    const badImport = await post(base, '/api/mcp/import', { document: exported.json });
    assert.equal(badImport.res.status, 400, 'MCP 导入缺少 confirm 应 400');

    const imported = await post(base, '/api/mcp/import', {
      confirm: true,
      document: exported.json,
    });
    assert.equal(imported.res.status, 200, `MCP 导入应 200，实际 ${imported.res.status}`);
    assert.equal(imported.json?.imported, 1, 'MCP 导入数量应为 1');
    assert.equal(imported.json?.backup !== null, true, 'MCP 导入应生成备份');

    const exportedAfter = await request(base, '/api/mcp/export');
    assert.equal(exportedAfter.res.status, 200, '导入后 MCP 导出应 200');
    assert.ok(
      (exportedAfter.json?.servers ?? []).some((s) => s.id === 'e2e-disabled'),
      '导入后配置导出没有恢复 server',
    );
    const statusAfter = await request(base, '/api/status');
    assert.equal(statusAfter.res.status, 200, '导入重建后 status 应 200');

    /**
     * ⑦ provider 切换 round-trip（真实重建运行时）
     *   有 Ollama 才测；切过去再切回 DeepSeek，确保不开倒车。
     */
    if (ollama?.configured === true) {
      const toOllama = await post(base, '/api/model', {
        action: 'switch',
        provider: 'ollama',
      });
      assert.equal(toOllama.res.status, 200, `切到 Ollama 应 200：${toOllama.text.slice(0, 200)}`);
      assert.equal(toOllama.json?.current?.provider, 'ollama', '切换后 current.provider 应为 ollama');
      const toOllamaStatus = await request(base, '/api/model');
      assert.equal(toOllamaStatus.json?.current?.provider, 'ollama', 'GET 应反映 Ollama');
      assert.equal(toOllamaStatus.json?.current?.streaming, false, 'Ollama 应标注非流式');

      const back = await post(base, '/api/model', {
        action: 'switch',
        provider: 'deepseek',
      });
      assert.equal(back.res.status, 200, `切回 DeepSeek 应 200：${back.text.slice(0, 200)}`);
      assert.equal(back.json?.current?.provider, 'deepseek', '切回后 current.provider 应为 deepseek');
      log('provider switch round-trip passed (ollama -> deepseek)');
    }

    log('all HTTP checks passed');
  } catch (err) {
    failure = err;
  } finally {
    await stopServer(child, [outFd, errFd]);
    if (failure !== undefined) {
      console.error(`[verify:http] FAILED: ${failure instanceof Error ? failure.message : String(failure)}`);
      for (const [label, path] of [
        ['stdout', outPath],
        ['stderr', errPath],
      ]) {
        try {
          const text = await readFile(path, 'utf8');
          const tail = text.trim().split(/\r?\n/).slice(-30).join('\n');
          if (tail.length > 0) console.error(`[verify:http] server ${label} tail:\n${tail}`);
        } catch {
          // 没有日志
        }
      }
      await rm(dir, { recursive: true, force: true });
      process.exitCode = 1;
    } else {
      await rm(dir, { recursive: true, force: true });
      log(`temp data cleaned: ${dir}`);
    }
  }
}

main().catch((err) => {
  console.error(`[verify:http] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
