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
    check('tier 分级符合方案 §9.4', specs.every((s) =>
      s.name === 'desktop_office_convert'
        ? s.tier === 'normal'
        : s.name === 'desktop_screenshot'
          ? s.tier === 'highRisk'
          : s.tier === 'readOnly',
    ));

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

    hr('⑥ 降级：桥关闭后调用必须失败（而不是假装成功）');

    bridge.close();
    let failedAfterClose = false;
    try {
      await bridge.ping();
    } catch {
      failedAfterClose = true;
    }
    check('★ 桥关闭后调用报错', failedAfterClose);

    hr('⑦ 进程无残留（Word 不能留在后台）');

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
