/**
 * P0 真实浏览器点击验证（临时/可复用脚本）
 *
 * 前置：seed-ui-fixture 启动的临时 server 在 3105，Edge 以 9222 远程调试打开页面。
 * 本脚本只做真实 DOM click + fetch 校验；不碰真实用户数据。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHELL = process.env.UI_BASE_URL ?? 'http://127.0.0.1:3105';
const CDP = process.env.UI_CDP_URL ?? 'http://127.0.0.1:9222';
const SHELL_HOST = new URL(SHELL).host;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes(SHELL_HOST));
assert.ok(page, '找不到 3105 的 CDP page target');
const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === undefined) return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(JSON.stringify(m.error)));
  else p.resolve(m.result);
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  return r.result?.value;
}

async function clickText(selector, text) {
  return await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((e) => (e.innerText || e.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

async function fetchJson(path, init) {
  const result = await evaluate(`fetch(${JSON.stringify(SHELL + path)}, ${JSON.stringify(init ?? {})}).then(async (r) => ({ status: r.status, body: await r.text() }))`);
  return { status: result.status, body: JSON.parse(result.body) };
}

const log = (msg) => console.log(`[ui-p0] ${msg}`);
await send('Runtime.enable');
await wait(500);

// C8：刷新后仍能从事件回放出取消回执。
await evaluate("location.hash = '#/chat'");
let cancellationVisible = false;
for (let i = 0; i < 24; i++) {
  await wait(250);
  cancellationVisible = await evaluate(
    "!!document.querySelector('.cancel-card') && document.body.innerText.includes('本轮已停止')",
  );
  if (cancellationVisible) break;
}
assert.ok(cancellationVisible, '取消回执没有从会话快照恢复');
log('cancellation receipt visible');
assert.ok(
  await evaluate("!!document.querySelector('button[aria-label=\"语音输入\"]')"),
  '对话页没有语音输入入口',
);
log('voice control visible');

// 0) 新建一个会话，供授权弹窗选择；确认当前页面是控制台记忆。
await fetchJson('/api/sessions', { method: 'POST' });
await evaluate("location.hash = '#/console/memory'");
await wait(1_200);
assert.ok((await evaluate("document.body.innerText.includes('花生过敏')")), '种子记忆未出现在页面');
log('seeded memory visible');
assert.ok(
  await evaluate("document.body.innerText.includes('可能冲突')"),
  '自动冲突标记未显示',
);
log('auto conflict badge visible');

await evaluate(`(() => {
  const card = [...document.querySelectorAll('.mem-card')].find((c) => c.innerText.includes('安静的位置'));
  if (!card) return false;
  card.querySelector('.mem-card-hit')?.click();
  return true;
})()`);
await wait(400);
assert.ok(
  await evaluate("document.body.innerText.includes('发现可能冲突') && document.body.innerText.includes('保留当前这条')"),
  '自动冲突详情/裁决入口未显示',
);
log('auto conflict detail/actions visible');

// 1) 敏感域授权
const memBefore = await fetchJson('/api/memory?q=%E8%8A%B1%E7%94%9F%E8%BF%87%E6%95%8F');
const sensitive = memBefore.body.items.find((m) => m.content.includes('花生过敏'));
assert.ok(sensitive, '找不到种子敏感记忆');
assert.equal(sensitive.grantCount, 0);

await evaluate(`(() => {
  const card = [...document.querySelectorAll('.mem-card')].find((c) => c.innerText.includes('花生过敏'));
  if (!card) return false;
  card.querySelector('.mem-card-hit')?.click();
  return true;
})()`);
await wait(500);
assert.equal(await clickText('button', '授权给当前任务'), true, '找不到授权按钮');
await wait(500);
assert.ok(await evaluate("!!document.querySelector('.modal-panel textarea')"), '授权弹窗没有用途输入框');
await evaluate(`(() => {
  const ta = document.querySelector('.modal-panel textarea');
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'P0 真实点击验证：晚餐订位');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await wait(200);
assert.equal(await clickText('.modal-panel button', '授权 30 分钟'), true, '找不到确认授权按钮');
await wait(1_200);
const memAfter = await fetchJson('/api/memory?q=%E8%8A%B1%E7%94%9F%E8%BF%87%E6%95%8F');
assert.equal(
  memAfter.body.items.find((m) => m.id === sensitive.id)?.grantCount,
  1,
  '授权后 grantCount 没有增加',
);
log('grant click verified: grantCount=1');

// 2) 手动冲突裁决：选“安静”，比较“热闹”，保留安静。
const conflictBefore = await fetchJson('/api/memory?q=%E7%83%AD%E9%97%B9%E7%9A%84%E9%9D%A0%E7%AA%97%E4%BD%8D');
const other = conflictBefore.body.items.find((m) => m.content.includes('热闹的靠窗位'));
assert.ok(other, '找不到第二条冲突记忆');
const otherFitnessBefore = other.fitness;

await evaluate(`(() => {
  const card = [...document.querySelectorAll('.mem-card')].find((c) => c.innerText.includes('安静的位置'));
  if (!card) return false;
  card.querySelector('.mem-card-hit')?.click();
  return true;
})()`);
await wait(500);
assert.equal(await clickText('button', '与另一条比较'), true, '找不到比较按钮');
await wait(800);
assert.ok(await evaluate("document.querySelectorAll('.compare-option').length > 0"), '比较弹窗没有候选');
await evaluate("document.querySelector('.compare-option')?.click()");
await wait(300);
assert.equal(await clickText('.modal-panel button', '保留当前这条'), true, '找不到保留当前按钮');
await wait(1_200);
const conflictAfter = await fetchJson('/api/memory?q=%E7%83%AD%E9%97%B9%E7%9A%84%E9%9D%A0%E7%AA%97%E4%BD%8D');
const otherAfter = conflictAfter.body.items.find((m) => m.id === other.id);
assert.ok(otherAfter, '裁决后找不到落败记忆');
assert.ok(otherAfter.fitness < otherFitnessBefore, `落败方适应度未下降：${otherFitnessBefore} -> ${otherAfter.fitness}`);
log(`conflict click verified: loser fitness ${otherFitnessBefore} -> ${otherAfter.fitness}`);

// 3) 设置页：演示导入 + 操作记忆写入
await evaluate("location.hash = '#/settings'");
await wait(2_500);
for (let i = 0; i < 20; i++) {
  if (await evaluate("!!document.querySelector('.model-provider-panel')")) break;
  await wait(250);
}
assert.ok(await evaluate("!!document.querySelector('.model-provider-panel')"), '设置页没有模型接入面板');
assert.ok(
  await evaluate(
    "document.querySelector('.model-provider-panel')?.innerText.includes('当前 · DeepSeek')",
  ),
  '模型接入面板没有显示当前 DeepSeek',
);
assert.ok(
  await evaluate(
    "document.querySelector('.model-provider-panel')?.innerText.includes('OpenAI 兼容') && document.querySelector('.model-provider-panel')?.innerText.includes('未配置')",
  ),
  '未配置的 OpenAI 兼容没有明确展示',
);
const providerCardState = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.model-provider-card')];
  const openai = cards.find((c) => c.innerText.includes('OpenAI 兼容'));
  const current = cards.find((c) => c.getAttribute('aria-pressed') === 'true');
  return {
    count: cards.length,
    openaiDisabled: openai?.disabled === true,
    currentIsDeepSeek: current?.innerText.includes('DeepSeek') === true,
    switchDisabled: [...document.querySelectorAll('.model-provider-actions button')]
      .find((b) => b.innerText.includes('切换并重启模型'))?.disabled === true,
  };
})()`);
assert.equal(providerCardState.count, 3, `模型卡片应为 3 个，实际 ${providerCardState.count}`);
assert.equal(providerCardState.openaiDisabled, true, '未配置的 OpenAI 卡片不应可点');
assert.equal(providerCardState.currentIsDeepSeek, true, '当前 provider 卡片不是 DeepSeek');
assert.equal(providerCardState.switchDisabled, true, '未验证时切换按钮不应可点');

const selectedOllama = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.model-provider-card')];
  const ollama = cards.find((c) => c.innerText.includes('Ollama 本地'));
  if (!ollama || ollama.disabled) return 'unavailable';
  ollama.click();
  return 'clicked';
})()`);
if (selectedOllama === 'clicked') {
  await wait(300);
  const ollamaState = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.model-provider-card')];
    const ollama = cards.find((c) => c.innerText.includes('Ollama 本地'));
    const switchBtn = [...document.querySelectorAll('.model-provider-actions button')]
      .find((b) => b.innerText.includes('切换并重启模型'));
    return {
      checked: ollama?.getAttribute('aria-pressed') === 'true',
      switchDisabled: switchBtn?.disabled === true,
      waiting: document.body.innerText.includes('待切换'),
    };
  })()`);
  assert.equal(ollamaState.checked, true, '点击 Ollama 后没有选中');
  assert.equal(ollamaState.switchDisabled, true, '未验证时切换按钮不应可点');
  assert.equal(ollamaState.waiting, true, '选择 Ollama 后没有显示待切换');

  // 真实点击验证：本地 Ollama 可用时跑一次非流式验证（约 30—45s）。
  const validateClicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.model-provider-actions button')]
      .find((b) => b.innerText.includes('验证所选端点'));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
  if (validateClicked) {
    let validated = false;
    for (let i = 0; i < 120; i++) {
      validated = await evaluate("!!document.querySelector('.model-provider-validation')");
      if (validated) break;
      await wait(500);
    }
    assert.ok(validated, 'Ollama 验证后没有显示验证结果');
    assert.ok(
      await evaluate("document.body.innerText.includes('端点验证通过')"),
      '验证结果没有通过文案',
    );
    const switchEnabled = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.model-provider-actions button')]
        .find((b) => b.innerText.includes('切换并重启模型'));
      return btn !== undefined && btn.disabled === false;
    })()`);
    assert.equal(switchEnabled, true, '验证通过后切换按钮仍不可点');
    log('model provider validation verified');
  }

  // 选回当前 provider，避免影响后续检查。
  await evaluate(`(() => {
    const deepseek = [...document.querySelectorAll('.model-provider-card')]
      .find((c) => c.innerText.includes('DeepSeek'));
    deepseek?.click();
  })()`);
  log('model provider panel verified');
} else {
  log('model provider panel verified (Ollama unavailable; selection skipped)');
}

assert.ok(
  await evaluate("document.body.innerText.includes('导出配置') && document.body.innerText.includes('导入配置')"),
  'MCP 配置入口没有显示',
);
assert.equal(await clickText('button', '导入配置'), true, '找不到 MCP 导入按钮');
await wait(400);
assert.ok(
  await evaluate("document.body.innerText.includes('导入 MCP 配置') && document.body.innerText.includes('env 值不会恢复')"),
  'MCP 导入确认弹窗内容不完整',
);
assert.equal(await clickText('.modal-panel button', '取消'), true, '找不到 MCP 导入取消按钮');
await wait(300);
log('MCP config entry/modal verified');

assert.equal(await clickText('button', '添加服务器'), true, '找不到 MCP 添加按钮');
await wait(300);
const switched = await evaluate(`(() => {
  const select = document.querySelector('.mcp-form select');
  if (!select) return false;
  select.value = 'http';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
assert.equal(switched, true, 'MCP 添加表单没有传输选择');
await wait(250);
assert.ok(
  await evaluate("!!document.querySelector('input[placeholder=\"https://mcp.example.com/mcp\"]')"),
  'HTTP 模式没有 URL 输入',
);
assert.ok(
  await evaluate("!document.querySelector('input[placeholder=\"例如 npx\"]')"),
  'HTTP 模式仍显示命令输入',
);
assert.ok(
  await evaluate("document.body.innerText.includes('这会离开本机')"),
  'HTTP 模式没有远程安全提示',
);
assert.equal(await clickText('.modal-panel button', '取消'), true, '找不到 MCP 添加取消按钮');
await wait(250);
log('MCP http form verified');

assert.ok(await evaluate("!!document.querySelector('.demo-card')"), '设置页没有演示卡');
const demoBtn = await clickText('.demo-card button', '导入演示数据');
assert.equal(demoBtn, true, '找不到演示导入按钮');
await wait(1_500);
const activity = await fetchJson('/api/activity');
assert.ok(activity.body.raw.length > 0, '演示导入后没有原始记录');
log(`demo click verified: raw=${activity.body.raw.length}`);

const recordBtn = await clickText('.ops-add button', '记录');
assert.equal(recordBtn, true, '找不到操作记忆记录按钮');
await wait(300);
await evaluate(`(() => {
  const form = document.querySelector('.ops-add-form');
  if (!form) return false;
  const setInput = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setInput(form.querySelector('textarea'), 'P0 点击验证：偏好简短回复');
  const inputs = form.querySelectorAll('input');
  setInput(inputs[0], '写邮件');
  setInput(inputs[1], '用户原话');
  return true;
})()`);
await wait(200);
assert.equal(await clickText('.ops-add-form button', '保存'), true, '找不到操作记忆保存按钮');
await wait(1_200);
const ops = await fetchJson('/api/operations?kind=preference');
assert.ok(
  ops.body.operations.some((o) => o.content === 'P0 点击验证：偏好简短回复'),
  '操作记忆没有写入',
);
log('operation click verified');

// 4) 产出物 CSV 下载
const downloadDir = await mkdtemp(join(tmpdir(), 'butler-ui-download-'));
try {
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.artifact-card')].find((c) => c.innerText.includes('周末晚餐清单'));
    if (!card) return false;
    card.querySelector('.artifact-head')?.click();
    return true;
  })()`);
  await wait(800);
  const href = await evaluate(`(() => {
    const a = [...document.querySelectorAll('a.text-btn')].find((x) => x.innerText.includes('下载 CSV'));
    return a?.href ?? null;
  })()`);
  assert.ok(typeof href === 'string' && href.includes('/download?format=csv'), '找不到 CSV 下载链接');
  const pdfHref = await evaluate(`(() => {
    const a = [...document.querySelectorAll('a.text-btn')].find((x) => x.innerText.includes('下载 PDF'));
    return a?.href ?? null;
  })()`);
  assert.ok(typeof pdfHref === 'string' && pdfHref.includes('/download?format=pdf'), '找不到 PDF 下载链接');
  const icsHref = await evaluate(`(() => {
    const a = [...document.querySelectorAll('a.text-btn')].find((x) => x.innerText.includes('下载 ICS'));
    return a?.href ?? null;
  })()`);
  assert.ok(typeof icsHref === 'string' && icsHref.includes('/download?format=ics'), '找不到 ICS 下载链接');
  await evaluate(`(() => {
    const a = [...document.querySelectorAll('a.text-btn')].find((x) => x.innerText.includes('下载 CSV'));
    a?.click();
    return true;
  })()`);
  await wait(1_500);
  const files = (await readdir(downloadDir)).filter((f) => f.endsWith('.csv'));
  assert.ok(files.length > 0, `没有下载到 CSV：${JSON.stringify(files)}`);
  const csv = await readFile(join(downloadDir, files[0]), 'utf8');
  assert.ok(csv.includes('清蒸鲈鱼'), 'CSV 内容不包含种子条目');
  log(`CSV click verified: ${files[0]}`);
} finally {
  await rm(downloadDir, { recursive: true, force: true });
}

// C8：真实发一轮，在流式过程中点“停止”，必须出现取消回执。
await evaluate("location.hash = '#/chat'");
await wait(600);
await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(ta, '请用三百字介绍杭州的春天，慢慢写，不要调用工具。');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await evaluate("document.querySelector('.send-btn:not(.send-btn--stop)')?.click()");
let sawStop = false;
for (let i = 0; i < 40; i++) {
  await wait(250);
  sawStop = await evaluate("!!document.querySelector('.send-btn--stop')");
  if (sawStop) break;
}
assert.ok(sawStop, '真实发送后没有出现停止按钮');
await evaluate("document.querySelector('.send-btn--stop')?.click()");
let liveCancel = false;
for (let i = 0; i < 30; i++) {
  await wait(250);
  liveCancel = await evaluate("!!document.querySelector('.cancel-card')");
  if (liveCancel) break;
}
assert.ok(liveCancel, '真实点击停止后没有取消回执');
log('live stop click verified');

// 凭证保险库入口可见（真实加密写入已在 verify:http 覆盖）。
await evaluate("location.hash = '#/settings'");
await wait(1_000);
assert.ok(
  await evaluate("document.body.innerText.includes('凭证保险库')"),
  '设置页没有凭证保险库入口',
);
log('credential vault entry visible');

// 文档库：真实文件输入 → 提取 → 入库，再检索。
for (let i = 0; i < 24; i++) {
  if (await evaluate("!!document.querySelector('.doc-panel')")) break;
  await wait(250);
}
const uploadDir = await mkdtemp(join(tmpdir(), 'butler-ui-upload-'));
const uploadName = `E2E上传-${Date.now()}.txt`;
const uploadPath = join(uploadDir, uploadName);
await writeFile(uploadPath, '花生过敏上传测试：这份文档用来验证真实文件上传链路。', 'utf8');
try {
  const beforeRows = await evaluate("document.querySelectorAll('.doc-row').length");
  await send('DOM.enable');
  const root = await send('DOM.getDocument', { depth: -1 });
  const node = await send('DOM.querySelector', {
    nodeId: root.root.nodeId,
    selector: '.doc-panel input[type="file"]',
  });
  assert.ok(node.nodeId > 0, '找不到文档库文件输入');
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [uploadPath] });
  let uploaded = false;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    uploaded = await evaluate(
      `document.querySelectorAll('.doc-row').length > ${beforeRows} && document.body.innerText.includes(${JSON.stringify(uploadName)})`,
    );
    if (uploaded) break;
  }
  assert.ok(uploaded, '真实文件上传没有进入文档库');
  log(`document upload verified: ${uploadName}`);
} finally {
  await rm(uploadDir, { recursive: true, force: true });
}

// 文档库：检索片段。
await evaluate(`(() => {
  const input = document.querySelector('.doc-search input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, 'LDL');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.doc-search button')].find((b) => b.innerText.includes('检索'));
  btn?.click();
  return !!btn;
})()`);
let docHit = false;
for (let i = 0; i < 40; i++) {
  await wait(250);
  docHit = await evaluate("!!document.querySelector('.doc-hit')");
  if (docHit) break;
}
assert.ok(docHit, '文档检索没有返回片段');
log('document search verified');

// 根级 error boundary：真实导航到一个会抛错的测试页。
await evaluate(`location.href = ${JSON.stringify(`${SHELL}/e2e-error`)}`);
let errorScreen = false;
for (let i = 0; i < 24; i++) {
  await wait(250);
  errorScreen = await evaluate("!!document.querySelector('.error-screen')");
  if (errorScreen) break;
}
assert.ok(errorScreen, '错误页没有被根级 error boundary 接管');
log('error boundary verified');
await evaluate(`location.href = ${JSON.stringify(`${SHELL}/#/chat`)}`);
await wait(800);

ws.close();
console.log('[ui-p0] ALL UI CHECKS PASSED');
