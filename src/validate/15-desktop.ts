/**
 * 验证 15：桌面控制（v8 · 方案 §9）
 *
 * ★ 这个脚本**真的调 Python 桥、真的转一次 Word→PDF** ——
 *   不是用假桥。桌面控制是唯一无法靠单测覆盖的部分：
 *   COM 会不会弹窗、Word 会不会卡死、中文会不会乱码，
 *   只有真跑才知道。
 *
 * ⚠️ 判定原则（**不许把"没装环境"记成"通过"**）：
 *   · 本机缺 Python / 缺 win32com → **跳过并明确标注「未验证」**，计入 skip 而不计入 pass
 *   · 只有在真跑成功时才计入 pass
 *   这是刻意的：一个"因环境缺失而绿"的验证脚本，比没有更糟 ——
 *   它会让人以为桌面控制已经验证过了。
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { PythonDesktopBridge } from '../adapters/desktop/pythonBridge.js';
import { desktopTools } from '../core/tools/builtin/desktop.js';
import { isDesktopPlatform } from '../core/desktop/port.js';
import { EventLog } from '../core/events/log.js';
import { OperationMemoryStore } from '../core/memory/operations.js';
import { FixedClock } from '../core/ports/clock.js';

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  }
}

function skip(label: string, why: string): void {
  skipped++;
  console.log(`  ⊘ ${label}  —— 未验证：${why}`);
}

function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

const BRIDGE_SCRIPT = 'scripts/desktop_bridge.py';

/** 本机是否有 python（不假设） */
function pythonAvailable(): boolean {
  try {
    const r = spawnSync('python', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  hr('① 平台与 Python 可用性（决定后面是"验证"还是"跳过"）');

  const onWindows = isDesktopPlatform();
  check('运行在 Windows（COM/UIA 的前提）', onWindows, process.platform);

  const hasPython = pythonAvailable();
  check('Python 可用', hasPython);

  if (!onWindows || !hasPython) {
    skip('桌面控制全部项目', '缺 Windows 或 Python');
    console.log(`\n  通过 ${passed}/${passed + failed}，跳过 ${skipped} 项`);
    console.log('\n▶ 验证 15 未验证：环境缺失（**不算通过**）\n');
    process.exit(0);
  }

  const bridge = new PythonDesktopBridge({ scriptPath: BRIDGE_SCRIPT });
  const dir = mkdtempSync(join(tmpdir(), 'butler-validate15-'));

  try {
    hr('② 协议：ping 报告真实能力');

    const caps = await bridge.ping();
    check('拿到 Python 版本', caps.python.length > 0, caps.python);
    check('平台是 win32', caps.platform === 'win32', caps.platform);
    check('win32com 可用（COM 层前提）', caps.capabilities['win32com'] === true);
    check('uiautomation 可用（UIA 层前提）', caps.capabilities['uiautomation'] === true);

    hr('③ 工具按能力注册（缺模块就不注册）');

    const specs = desktopTools(bridge, caps.capabilities);
    check('至少注册了一个桌面工具', specs.length > 0, specs.map((s) => s.name).join(', '));
    check(
      '★ 注册的工具与能力一致（没能力就不注册）',
      specs.every((s) =>
        s.name === 'desktop_office_convert'
          ? caps.capabilities['win32com'] === true
          : s.name === 'desktop_list_windows'
            ? caps.capabilities['uiautomation'] === true
            : caps.capabilities['mss'] === true || caps.capabilities['PIL'] === true,
      ),
    );
    /**
     * ★ tier 必须与方案 §9.4 的分层一致。
     *
     * ⚠️ 这个检查第一版只按 3 个工具写死了映射，
     *    加入 `desktop_uia_invoke` / `desktop_uia_set_value` 之后，
     *    它们（highRisk）落进了 `else → readOnly` 分支，于是**检查本身报错**。
     *    那是检查过时，不是分级错了 —— 所以这里改成**显式声明期望值**，
     *    新增工具若没在表里登记，会直接判失败（逼着人来更新）。
     */
    const EXPECTED_TIER: Record<string, 'readOnly' | 'normal' | 'highRisk' | 'dangerous'> = {
      desktop_office_convert: 'normal', // ① COM：需确认的写操作
      desktop_list_windows: 'readOnly', // ② UIA：只读
      desktop_uia_read: 'readOnly', // ② UIA：只读
      desktop_uia_invoke: 'highRisk', // ② UIA：改变应用状态
      desktop_uia_set_value: 'highRisk', // ② UIA：改变应用状态
      desktop_wait_for: 'readOnly', // ② UIA：只等不动手
      desktop_screenshot: 'highRisk', // ③ 视觉：每次确认 + 高风险（会读到屏幕全部内容）
    };
    const unregistered = specs.filter((s) => EXPECTED_TIER[s.name] === undefined);
    check(
      '★ 每个工具都在分级表里登记过（新增工具必须补表）',
      unregistered.length === 0,
      unregistered.map((s) => s.name).join(', ') || '全部已登记',
    );
    const wrongTier = specs.filter((s) => EXPECTED_TIER[s.name] !== undefined && s.tier !== EXPECTED_TIER[s.name]);
    check(
      '★ tier 分级符合方案 §9.4',
      wrongTier.length === 0,
      wrongTier.map((s) => `${s.name}=${s.tier}(期望 ${EXPECTED_TIER[s.name]})`).join(', ') ||
        specs.map((s) => `${s.name}=${s.tier}`).join(' '),
    );

    hr('④ UIA：真的列出窗口');

    const winTool = specs.find((s) => s.name === 'desktop_list_windows');
    if (winTool === undefined) {
      skip('列出窗口', 'uiautomation 不可用');
    } else {
      const r = await winTool.execute({ limit: 5 }, {} as never);
      check('列出成功', r.ok);
      check('返回了非空文本', r.output.length > 0);
      // 中文标题不能是乱码 —— 显式 UTF-8 的直接验证
      check('★ 输出里没有乱码替换字符', !r.output.includes('\uFFFD'), r.output.split('\n')[0]);
      console.log(`     第一行：${r.output.split('\n')[0] ?? ''}`);
    }

    hr('⑤ ★★ COM：真的把 Word 文档转成 PDF（方案 §9.2 的演示场景）');

    const convTool = specs.find((s) => s.name === 'desktop_office_convert');
    if (convTool === undefined) {
      skip('Word→PDF 转换', 'win32com 不可用');
    } else {
      // 先造一份 .docx（用 Word COM，与转换走同一条路）
      const src = join(dir, 'sample.docx');
      const dst = join(dir, 'sample.pdf');
      const made = makeDocx(src);
      check('测试用 .docx 已生成', made, src);

      if (made) {
        const before = statSync(src).size;
        const r = await convTool.execute({ source: src, target: dst }, {} as never);

        check('转换成功', r.ok);
        const pdfExists = statSync(dst, { throwIfNoEntry: false }) !== undefined;
        check('★ PDF 真的落盘了', pdfExists, dst);
        if (pdfExists) {
          const pdfSize = statSync(dst).size;
          check('★ PDF 非空', pdfSize > 0, `${pdfSize} 字节（源 ${before} 字节）`);
          // PDF 魔数：%PDF-
          check('★ 文件确实是 PDF（魔数校验）', isPdf(dst));
        }

        // 参数校验：非 .pdf 目标必须在**调用桥之前**被拒
        let rejected = false;
        try {
          await convTool.execute({ source: src, target: join(dir, 'x.docx') }, {} as never);
        } catch {
          rejected = true;
        }
        check('★ target 非 .pdf 被拒', rejected);
      }
    }

    hr('⑥ ★★ UIA 按元素操作（不按坐标）：对「设置」做真实导航与开关');

    /**
     * ★ 为什么用「设置」而不是酷狗：
     *   设置是 WinUI/XAML 应用，控件有名字、实现了标准 UIA 模式 ——
     *   这正是 ② UIA 层能覆盖的范围。
     *
     *   酷狗实测（另一次人工验证）是自绘 UI：`ValuePattern.SetValue` 抛 COMError、
     *   坐标点击会被叠加窗口吞掉。**那是 UIA 层的边界，不是它的能力**。
     *
     * ⚠️ 这一段会**临时改动**「在我的设备上使用动态光效」，
     *    结束时必须恢复原值 —— 所以先记下初始状态，最后比对。
     */
    const initialLighting = readLightingReg();
    check('能读到动态光效的初始状态（注册表）', initialLighting !== null, `AmbientLightingEnabled=${String(initialLighting)}`);

    /**
     * ★★ 这一段刻意**不用 sleep**，改用轮询等待。
     *
     * 之前写的是 `await sleep(4500)` —— 那是"闭眼数秒"：
     * 机器慢就假失败，机器快就白等。现在用 `waitFor` 工具的真实逻辑：
     * 看到就继续，看不到才等到超时。
     */
    const waitTool = specs.find((s) => s.name === 'desktop_wait_for');
    check('★ 注册了等待工具 desktop_wait_for', waitTool !== undefined);

    // 打开设置（不指定页面，让 UIA 自己导航 —— 那才是被测的能力）
    spawnSync('cmd', ['/c', 'start', '', 'ms-settings:'], { timeout: 15_000 });

    const waitWindow = waitTool !== undefined
      ? await waitTool.execute({ window: '设置', timeoutMs: 20_000 }, {} as never)
      : { ok: false, output: '（无等待工具）' };
    check('★★ 等到「设置」窗口出现（轮询，不是固定 sleep）', waitWindow.ok, waitWindow.output.split('\n')[0] ?? '');

    const win = await bridge.uiaFind('设置', '个性化');
    check('★ 找到「设置」窗口（按标题定位）', win.count > 0, `${win.count} 个匹配`);
    check(
      '★ 导航项「个性化」支持 SelectionItem 模式',
      win.matches.some((m) => m.type === 'ListItemControl' && (m.patterns ?? []).includes('SelectionItem')),
      win.matches.map((m) => `${m.type}:${(m.patterns ?? []).join('/')}`).join(' | '),
    );

    const sel = await bridge.uiaAction('设置', '个性化', 'select', 'listitem');
    check('★★ 选中「个性化」且**状态校验通过**', sel.verified === true, `${String(sel.before)} → ${String(sel.after)}`);

    // 「动态光效」有三个同名控件，必须用 controlType 消歧 —— 这一步本身就在验证"拒绝猜测"
    const dlAll = await bridge.uiaFind('设置', '动态光效');
    check('★ 「动态光效」存在多个同名控件（说明消歧是必要的）', dlAll.count > 1, `${dlAll.count} 个`);
    const dlIn = await bridge.uiaAction('设置', '动态光效', 'invoke', 'listitem');
    check('★★ 进入「动态光效」页', dlIn.control.type === 'ListItemControl', dlIn.control.automationId);

    const toggleName = '在我的设备上使用动态光效';

    // ★ 用等待工具替代 `sleep(2500)`：页面切换是异步的
    const waitToggle = waitTool !== undefined
      ? await waitTool.execute(
          { window: '设置', name: toggleName, timeoutMs: 15_000, pollMs: 200 },
          {} as never,
        )
      : { ok: false, output: '（无等待工具）' };
    check('★★ 等到开关控件出现（轮询，不是固定 sleep）', waitToggle.ok, waitToggle.output.split('\n')[0] ?? '');

    const tf = await bridge.uiaFind('设置', toggleName);
    const toggleCtl = tf.matches.find((m) => (m.patterns ?? []).includes('Toggle'));
    check('★ 找到开关控件且支持 Toggle 模式', toggleCtl !== undefined, toggleCtl?.automationId ?? '未找到');

    if (toggleCtl !== undefined) {
      // ① 切换一次
      const t1 = await bridge.uiaAction('设置', toggleName, 'toggle', 'button');
      check('★★ 开关状态确实变了（读回校验）', t1.verified === true, `${String(t1.before)} → ${String(t1.after)}`);
      const reg1 = readLightingReg();
      const expected1 = t1.after === 1 ? 1 : 0;
      check('★★ 注册表随之改变（跨层交叉验证）', reg1 === expected1, `注册表=${String(reg1)}，期望=${expected1}`);

      // ② 切回原状
      const t2 = await bridge.uiaAction('设置', toggleName, 'toggle', 'button');
      check('★★ 再切一次也校验通过', t2.verified === true, `${String(t2.before)} → ${String(t2.after)}`);
      const reg2 = readLightingReg();
      check('★★ 注册表**恢复原值**（不留下改动）', reg2 === initialLighting, `${String(reg2)} / 初始 ${String(initialLighting)}`);
    }

    // 关闭设置
    const closed = await bridge.uiaAction('设置', '关闭 设置', 'invoke');
    check('★ 关闭「设置」窗口', closed.control.type === 'ButtonControl');

    /**
     * ⚠️ 这里**保留 sleep**，因为它是"等东西消失" —— 而等待工具只能等"出现"。
     *    ⚠️ 而且判据必须是"窗口不在了"，不能用"uiaFind 抛错"来判断：
     *       `uiaFind('设置', ...)` 抛错可能是因为**窗口还在但控件没了**。
     *       所以这里用 `uiaFind` 的 count 判断，并允许它抛错（抛错=窗口已不存在）。
     */
    await sleep(1500);
    const stillThere = await bridge
      .uiaFind('设置', '个性化')
      .then((r) => r.count > 0)
      .catch(() => false);
    check('★ 设置确实关掉了', !stillThere);

    hr('⑦ 操作记忆：真实仓储能不能接住这个参数形状');

    /**
     * ★ 为什么要这一段：单元测试用的是**假仓储**，只能证明"我们调了它"，
     *   不能证明**真实仓储接受这个参数形状**（少个必填字段、签名算法不认，
     *   单测都照样绿）。这里用真实 `OperationMemoryStore` 跑一遍。
     */
    {
      const opsLog = new EventLog('__event_log__');
      // 仓储需要 clock 与 random —— 这里给确定性的，避免验证结果不稳定
      const opsClock = new FixedClock(1_760_000_000_000);
      const opsRandom = {
        next: (): number => 0.5,
        pick: <T,>(items: readonly T[]): T | undefined => items[0],
      };
      const ops = new OperationMemoryStore(opsLog, opsClock, 'local', opsRandom);

      const before = ops.all().length;
      ops.recordAttempt({
        task: '把一批 Word 文档转成 PDF',
        app: 'Word',
        path: 'api',
        success: true,
        durationMs: 1200,
        method: 'Word COM SaveAs PDF',
      });
      check('★ 真实仓储记录成功（新增 1 条）', ops.all().length === before + 1, `${before} → ${ops.all().length}`);

      // 再记一次失败，验证"失败也能记、并且推荐会把它降级"
      ops.recordAttempt({
        task: '把一批 Word 文档转成 PDF',
        app: 'Word',
        path: 'uia',
        success: false,
        durationMs: 800,
        failureReason: '找不到"导出为 PDF"菜单项',
        method: 'UIA 点击菜单',
      });
      check('★ 真实仓储记录失败（累计 2 条）', ops.all().length === before + 2);

      const rec = ops.recommend({ task: '把一批 Word 文档转成 PDF', app: 'Word' });
      check('★★ 推荐用上了历史（usedMemory=true）', rec.usedMemory === true, rec.taskSignature);
      check(
        '★★ 成功过的 api 排在失败过的 uia 前面',
        rec.ranked.findIndex((p) => p.path === 'api') < rec.ranked.findIndex((p) => p.path === 'uia'),
        rec.ranked.map((p) => `${p.path}:${p.score.toFixed(2)}`).join(' > '),
      );

      // ★ 事件必须落下来（否则重放后记忆就没了）
      // ⚠️ 事件类型是 `fitness.updated`（不是 `operation.recorded`）——
      //    仓储复用了这个事件，payload 里用 `kind: 'operation'` 区分
      const opEvents = opsLog
        .byType('fitness.updated')
        .filter((e) => (e.payload as { kind?: string }).kind === 'operation').length;
      check('★★ 记录写进了事件流（可重放）', opEvents >= 2, `fitness.updated(operation) × ${opEvents}`);

      // ── 记忆会过期（方案 §6.3⑤ 第 3 层）──
      //
      // ★ 用**真实仓储**验证"连续失败 → 标记过期、但不从列表删除"。
      //   这条是用户明确担心的场景：软件更新后，旧经验可能已经不对了。
      for (let i = 0; i < 2; i++) {
        ops.recordAttempt({
          task: '打开动态光效',
          app: '设置',
          path: 'uia',
          success: false,
          durationMs: 300,
          failureReason: '找不到开关控件',
        });
      }
      const staleRec = ops.recommend({ task: '打开动态光效', app: '设置' });
      const uiaRec = staleRec.ranked.find((p) => p.path === 'uia');
      check('★★ 连续失败 2 次 → 标记为可能已过期', uiaRec?.stale === true, `stale=${String(uiaRec?.stale)}`);
      check('★★ 过期提示写进了推荐理由', (uiaRec?.why ?? '').includes('先验证'));
      check('★★★ 但**仍留在推荐列表里**（环境可能已变，不能永久排除）', uiaRec !== undefined);

      // 一次成功 → 过期标记消失（"路修好了就继续走"）
      ops.recordAttempt({ task: '打开动态光效', app: '设置', path: 'uia', success: true, durationMs: 150 });
      const revived = ops.recommend({ task: '打开动态光效', app: '设置' });
      check(
        '★★ 成功一次就摘掉过期标记（可自愈）',
        revived.ranked.find((p) => p.path === 'uia')?.stale === undefined,
        revived.stale.join(',') || 'stale 为空',
      );

      // ── 按应用聚合（跨说法稳定）──
      //
      // ★ 这一段的依据是**实测事实**：同一件事的 5 种中文说法会算出 5 个不同签名
      //   （"把 Word 转 PDF" / "导出成 pdf" / "另存为 PDF" …），
      //   按签名召回几乎不命中；而"这个应用上哪条路走得通"是跨说法稳定的。
      const beforeApp = ops.byApp('设置').samples;
      ops.recordAttempt({ task: '把那个开关切到开启状态', app: '设置', path: 'uia', success: true, durationMs: 180 });
      const appAgg = ops.byApp('设置');
      check('★★ 应用级聚合能收下"不同说法"的记录', appAgg.samples > beforeApp, `${beforeApp} → ${appAgg.samples}`);
      check('★★ 应用级给出该应用最可靠的路径', appAgg.ranked[0]?.path === 'uia', appAgg.ranked[0]?.why ?? '');

      // 换一个完全不同的说法查：任务签名不命中，但应用级兜底
      const fallback = ops.recommend({ task: '让那盏灯亮起来', app: '设置' });
      check(
        '★★ 签名没命中时用应用级兜底（不会"什么都没学到"）',
        fallback.appLevel !== undefined && fallback.usedMemory === true,
        `appLevel.samples=${String(fallback.appLevel?.samples)}`,
      );
    }

    hr('⑧ 降级：桥关闭后调用必须失败（而不是假装成功）');

    bridge.close();
    let failedAfterClose = false;
    try {
      await bridge.ping();
    } catch {
      failedAfterClose = true;
    }
    check('★ 桥关闭后调用报错', failedAfterClose);

    hr('⑧ 进程无残留（Word 不能留在后台）');

    /**
     * ⚠️ **Word 的退出是异步的** —— `Quit()` 返回时进程可能还在收尾。
     *
     * 第一版在这里直接数进程，得到 `WINWORD.EXE × 1` 判失败；
     * 但几分钟后再查是 0，说明那是**收尾中的瞬态**，不是泄漏。
     * 所以这里改成**轮询等待**（最多 10 秒），并且把等待时长打出来。
     *
     * ★ 这条断言仍然有价值：如果 `Quit()` 真的没被调用（比如 finally 写漏了），
     *   等多久都不会变 0 —— 那时它会稳定失败。
     */
    const waitStart = Date.now();
    let words = countProcess('WINWORD.EXE');
    while (words > 0 && Date.now() - waitStart < 10_000) {
      await sleep(500);
      words = countProcess('WINWORD.EXE');
    }
    check(
      '★ 没有残留的 Word 进程（等它退出）',
      words === 0,
      `WINWORD.EXE × ${words}，等待 ${Date.now() - waitStart}ms`,
    );

    hr('结果');
    const total = passed + failed;
    console.log(`  通过 ${passed}/${total}${skipped > 0 ? `，跳过 ${skipped}` : ''}`);
    if (failed > 0) {
      console.log(`  ✗ 失败 ${failed} 项`);
      console.log('\n▶ 验证 15 未通过\n');
      process.exit(1);
    }
    console.log('\n▶ 验证 15 通过：桌面控制成立（协议 / 注册 / UIA / COM 真转换 / 降级 / 无残留）\n');
  } finally {
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 用 Word COM 造一份 .docx（与转换同源，避免引入额外依赖） */
function makeDocx(path: string): boolean {
  const py = `
import sys, os
import win32com.client
path = sys.argv[1]
word = win32com.client.DispatchEx("Word.Application")
word.Visible = False
word.DisplayAlerts = 0
try:
    doc = word.Documents.Add()
    doc.Content.Text = "管家式 AI 桌面控制验证：Word 在后台转换成 PDF，全程不弹窗。"
    doc.SaveAs(os.path.abspath(path), FileFormat=16)
    doc.Close(SaveChanges=0)
finally:
    word.Quit()
print("ok")
`;
  const r = spawnSync('python', ['-c', py, path], { encoding: 'utf8', timeout: 120_000 });
  return r.status === 0 && statSync(path, { throwIfNoEntry: false }) !== undefined;
}

/** 校验 PDF 魔数 */
function isPdf(path: string): boolean {
  try {
    // 读前 5 字节即可
    const r = spawnSync(
      'python',
      ['-c', 'import sys;print(open(sys.argv[1],"rb").read(5).decode("latin1"))', path],
      { encoding: 'utf8', timeout: 15_000 },
    );
    return (r.stdout ?? '').trim() === '%PDF-';
  } catch {
    return false;
  }
}

/** 简单的等待（不引入依赖） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 读「在我的设备上使用动态光效」的真实状态（注册表）。
 *
 * ★ 为什么要读注册表：UIA 报的 `ToggleState` 是**界面**状态，
 *   注册表才是**系统**状态。两者一致才能证明"操作真的生效了"，
 *   而不是只改了个显示。
 */
function readLightingReg(): number | null {
  try {
    const r = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Lighting', '/v', 'AmbientLightingEnabled'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const out = r.stdout ?? '';
    const m = /AmbientLightingEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    if (m === null) return null;
    return parseInt(m[1] as string, 16);
  } catch {
    return null;
  }
}

/** 数一下某个进程还有几个（不依赖 wmic，用 tasklist） */
function countProcess(imageName: string): number {
  try {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const out = r.stdout ?? '';
    if (out.includes('No tasks') || out.includes('没有运行的任务')) return 0;
    return out.split('\n').filter((l) => l.toLowerCase().includes(imageName.toLowerCase())).length;
  } catch {
    return -1;
  }
}

void readdirSync;
await main();
