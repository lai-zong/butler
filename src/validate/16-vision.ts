/**
 * 验证 16：多模态输入（方案 §5.3 / E3 图片送进模型）
 *
 * ★ 这里要证明的是**模型真的看到了图**，而不是"请求没报错"。
 *   判据：给它**可区分**的纯色图，看回答的颜色对不对。
 *
 * ⚠️ 没有 API key 时**跳过**（记 skip，**不记通过**）：
 *    一个"因缺 key 而绿"的验证脚本比没有更糟 —— 它会让人以为图片能力已验证。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toApiMessages } from '../adapters/model/convert.js';
import { classifyAttachment, detectMime, isVisionReadable } from '../core/multimodal/attach.js';

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
  console.log(`  ⊘ ${label} —— 未验证：${why}`);
}

function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

/** 用系统 Python + PIL 生成纯色 PNG（不引新依赖） */
function makeSolidPng(path: string, rgb: [number, number, number]): boolean {
  const py = `
import sys
from PIL import Image
Image.new("RGB", (64, 64), (${rgb[0]}, ${rgb[1]}, ${rgb[2]})).save(sys.argv[1])
`;
  const r = spawnSync('python', ['-c', py, path], { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'butler-validate16-'));

  try {
    hr('① 结构：图片必须变成数组形式的 content');

    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const withImage = toApiMessages([
      {
        role: 'user',
        content: [
          { kind: 'text', text: '看图' },
          { kind: 'image', url: dataUrl, detail: 'high' },
        ],
      },
    ]);
    const parts = withImage[0]?.content;
    check('★ 带图片时 content 是数组', Array.isArray(parts));
    if (Array.isArray(parts)) {
      check('★ 片段顺序：文本在前、图片在后', parts[0]?.type === 'text' && parts[1]?.type === 'image_url');
      const img = parts[1];
      check(
        '★ 图片 URL 与 detail 正确传递',
        img?.type === 'image_url' && img.image_url.url === dataUrl && img.image_url.detail === 'high',
      );
    }

    const textOnly = toApiMessages([{ role: 'user', content: [{ kind: 'text', text: '你好' }] }]);
    check('★ 纯文本仍是 string（不因支持图片就全改数组）', typeof textOnly[0]?.content === 'string');

    let threw = false;
    try {
      toApiMessages([{ role: 'system', content: [{ kind: 'image', url: dataUrl }] }]);
    } catch {
      threw = true;
    }
    check('★★ 图片放进 system 消息 → 明确报错（协议不允许）', threw);

    hr('② 输入侧：真实字节的类型识别（不靠扩展名）');

    const pngPath = join(dir, 'red.png');
    const made = makeSolidPng(pngPath, [255, 0, 0]);
    check('测试图片已生成', made, pngPath);

    if (made) {
      const bytes = new Uint8Array(readFileSync(pngPath));
      const mime = detectMime(bytes);
      check('★★ 按**内容**识别出 image/png', mime === 'image/png', String(mime));
      check('★ 判定为可送模型', isVisionReadable(mime));
      const cls = classifyAttachment({
        filename: 'plain.txt',
        // 故意声明成文本 —— 若实现只看声明就会判错
        declaredMime: 'text/plain',
        sizeBytes: bytes.length,
        headBytes: bytes.slice(0, 64),
      });
      check(
        '★★ 声明成 text/plain 仍按内容判成图片（不信扩展名/声明）',
        cls.kind === 'image',
        `kind=${cls.kind}，detected=${String(cls.detectedMime)}`,
      );
    }

    hr('③ 真实调用：模型到底看没看到图');

    const envPath = join(process.cwd(), '.env.local');
    let key = process.env['DEEPSEEK_API_KEY'] ?? '';
    if (key.length === 0) {
      try {
        const text = readFileSync(envPath, 'utf8');
        key = /DEEPSEEK_API_KEY\s*=\s*(\S+)/.exec(text)?.[1] ?? '';
      } catch {
        key = '';
      }
    }

    if (key.length === 0) {
      skip('模型的图片识别', '没有 DEEPSEEK_API_KEY（**不算通过**）');
    } else {
      // 三种可区分的纯色：只有真看到图才可能全对
      const cases: Array<{ file: string; rgb: [number, number, number]; expect: RegExp; label: string }> = [
        { file: 'r.png', rgb: [255, 0, 0], expect: /红/, label: '红' },
        { file: 'b.png', rgb: [0, 0, 255], expect: /蓝/, label: '蓝' },
        { file: 'g.png', rgb: [0, 200, 0], expect: /绿/, label: '绿' },
      ];

      let hits = 0;
      for (const c of cases) {
        const p = join(dir, c.file);
        if (!makeSolidPng(p, c.rgb)) {
          check(`${c.label} 图生成`, false);
          continue;
        }
        const b64 = readFileSync(p).toString('base64');
        const msgs = toApiMessages([
          {
            role: 'user',
            content: [
              { kind: 'text', text: '这张图是什么颜色？只回答一个颜色词。' },
              { kind: 'image', url: `data:image/png;base64,${b64}`, detail: 'high' },
            ],
          },
        ]);

        let answer = '';
        let promptTokens = 0;
        try {
          const resp = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: 'deepseek-flash',
              messages: [{ role: 'system', content: '你只回答一个颜色词' }, ...msgs],
              max_tokens: 20,
              thinking: { type: 'disabled' },
            }),
          });
          const data = (await resp.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number };
          };
          answer = (data.choices?.[0]?.message?.content ?? '').trim();
          promptTokens = data.usage?.prompt_tokens ?? 0;
        } catch (err) {
          check(`${c.label} 图识别`, false, err instanceof Error ? err.message : String(err));
          continue;
        }

        const ok = c.expect.test(answer);
        if (ok) hits++;
        check(
          `★★ 模型看出这是${c.label}色`,
          ok,
          `回答=${JSON.stringify(answer)}，prompt_tokens=${promptTokens}`,
        );
        // 图片会被计入 token：全文字请求通常只有二三十 token
        check(`★ 图片 token 被计入（说明确实发了图）`, promptTokens > 100, `${promptTokens}`);
      }

      check('★★★ 三种颜色全对（排除"凭提示词瞎猜"）', hits === 3, `${hits}/3`);
    }

    hr('结果');
    const total = passed + failed;
    console.log(`  通过 ${passed}/${total}${skipped > 0 ? `，跳过 ${skipped}` : ''}`);
    if (failed > 0) {
      console.log(`  ✗ 失败 ${failed} 项`);
      console.log('\n▶ 验证 16 未通过\n');
      process.exit(1);
    }
    console.log('\n▶ 验证 16 通过：图片转换 / 内容识别 / 模型真读图\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
