/**
 * 多模态输入测试
 *
 * ★ 四组主张：
 *   ① **按内容识别，不按扩展名** —— 扩展名会撒谎，魔数不会
 *   ② 不确定时**反问用户**，不猜（猜错会把任务派给错误的仆人）
 *   ③ 模型能力必须**显式声明** —— 防「图片被静默忽略却报成功」
 *   ④ 多模态信息**进记忆**（本模块的增分点）
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  VISION_MIMES,
  checkLimits,
  classifyAttachment,
  detectMime,
  extractMemoryCandidates,
  isVisionReadable,
  routeAttachment,
  type ParsedAttachment,
} from '../attach.js';
import { capabilitiesOf, knownModels } from '../../../adapters/model/deepseek.js';
import { CONSERVATIVE_CAPABILITIES } from '../../ports/model.js';

/** 构造字节头。 */
const head = (...bytes: number[]): Uint8Array => new Uint8Array(bytes);

describe('① ★ 按内容识别，不按扩展名', () => {
  it('★ 认出 PNG（真实魔数）', () => {
    expect(detectMime(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
  });

  it('认出 JPEG / GIF', () => {
    expect(detectMime(head(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(detectMime(head(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
  });

  it('★ 区分同为 RIFF 开头的 WebP 与 WAV', () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0];
    const webp = new Uint8Array([...riff, 0x57, 0x45, 0x42, 0x50]); // "WEBP"
    const wav = new Uint8Array([...riff, 0x57, 0x41, 0x56, 0x45]); // "WAVE"
    expect(detectMime(webp)).toBe('image/webp');
    expect(detectMime(wav)).toBe('audio/wav');
  });

  it('认出 PDF', () => {
    expect(detectMime(head(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe('application/pdf');
  });

  it('认出纯文本', () => {
    expect(detectMime(new Uint8Array([...'hello world, this is text'].map((c) => c.charCodeAt(0))))).toBe('text/plain');
  });

  it('★ 认不出的返回 null（不瞎猜）', () => {
    expect(detectMime(head(0x00, 0x01, 0x02, 0x03, 0x04))).toBeNull();
  });

  it('空输入不崩溃', () => {
    expect(detectMime(new Uint8Array())).toBeNull();
  });

  it('★ 只有四种格式能直接喂给模型（与官方文档一致）', () => {
    expect([...VISION_MIMES].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
    expect(isVisionReadable('image/png')).toBe(true);
    expect(isVisionReadable('image/bmp')).toBe(false);
    expect(isVisionReadable(null)).toBe(false);
  });
});

describe('① 分类：内容优先，文件名仅作提示', () => {
  it('★ PNG + 文件名含"收据" → 判为收据', () => {
    const r = classifyAttachment({
      filename: '2026-10-receipt.png',
      declaredMime: 'image/png',
      sizeBytes: 1000,
      headBytes: head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    });
    expect(r.kind).toBe('receipt');
    expect(r.detectedMime).toBe('image/png');
    expect(r.needsUserConfirmation).toBe(false);
  });

  it('中文文件名同样识别', () => {
    const r = classifyAttachment({
      filename: '本月账单.png',
      declaredMime: 'image/png',
      sizeBytes: 1000,
      headBytes: head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    });
    expect(r.kind).toBe('receipt');
  });

  it('★ 文件名撒谎也骗不过去：叫 receipt.png 但内容是 PDF', () => {
    const r = classifyAttachment({
      filename: 'receipt.png',
      declaredMime: 'image/png',
      sizeBytes: 1000,
      headBytes: head(0x25, 0x50, 0x44, 0x46, 0x2d),
    });
    // 内容说是 PDF → 按文档处理，而不是按文件名当收据
    expect(r.kind).toBe('document');
    expect(r.detectedMime).toBe('application/pdf');
  });

  it('★ 普通图片用途不明 → 需要用户确认', () => {
    const r = classifyAttachment({
      filename: 'IMG_20261013.png',
      declaredMime: 'image/png',
      sizeBytes: 1000,
      headBytes: head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    });
    expect(r.kind).toBe('image');
    expect(r.needsUserConfirmation).toBe(true);
  });

  it('★ 认不出内容、文件名也无线索 → 需确认（不猜）', () => {
    const r = classifyAttachment({
      filename: 'x.bin',
      declaredMime: 'application/octet-stream',
      sizeBytes: 100,
      headBytes: head(0x00, 0x01, 0x02),
    });
    expect(r.kind).toBe('unknown');
    expect(r.needsUserConfirmation).toBe(true);
    expect(r.why).toContain('无法');
  });

  it('没有字节头时退回文件名，并明确标注仅供参考', () => {
    const r = classifyAttachment({
      filename: 'report.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 100,
    });
    expect(r.kind).toBe('document');
    expect(r.needsUserConfirmation).toBe(true);
    expect(r.why).toContain('仅供参考');
  });
});

describe('② ★ 路由到正确的仆人', () => {
  it('★ 收据 → 健康仆人（方案 § 5.3 的映射）', () => {
    const d = routeAttachment({ kind: 'receipt', needsUserConfirmation: false });
    expect(d.domain).toBe('health');
  });

  it('代码 → 代码仆人', () => {
    expect(routeAttachment({ kind: 'code', needsUserConfirmation: false }).domain).toBe('code');
  });

  it('表格 → 办公仆人', () => {
    expect(routeAttachment({ kind: 'spreadsheet', needsUserConfirmation: false }).domain).toBe('work');
  });

  it('语音 → 先交给管家转写', () => {
    const d = routeAttachment({ kind: 'audio', needsUserConfirmation: false });
    expect(d.domain).toBe('butler');
    expect(d.why).toContain('转写');
  });

  it('★ 需要确认时不给仆人，而是给出反问文本', () => {
    const d = routeAttachment({ kind: 'image', needsUserConfirmation: true });
    expect(d.domain).toBeNull();
    expect(d.question).toBeDefined();
    expect(d.question?.length).toBeGreaterThan(0);
  });

  it('★ 截图内容未知 → 反问，不擅自派发', () => {
    const d = routeAttachment({ kind: 'screenshot', needsUserConfirmation: false });
    expect(d.domain).toBeNull();
    expect(d.question).toContain('截图');
  });

  it('每种类型都有明确的去向或反问', () => {
    const kinds = ['receipt', 'screenshot', 'document', 'spreadsheet', 'code', 'image', 'audio', 'unknown'] as const;
    for (const kind of kinds) {
      const d = routeAttachment({ kind, needsUserConfirmation: false });
      expect(d.domain !== undefined || d.question !== undefined).toBe(true);
      expect(d.why.length).toBeGreaterThan(0);
    }
  });
});

describe('③ ★ 模型能力必须显式声明', () => {
  /**
   * ⚠️ 这里原先断言 `deepseek-chat` 支持视觉，**已删除**。
   *    该模型不在官方清单里，且当时那条"实测"很可能是假象
   *    （请求被 API 静默路由到 flash）。模型已下线，无法复核。
   *    现在能力表只登记官方在售的模型。
   */
  it('★★ deepseek-v4-pro **明确不声明读图**（官方文档 Not supported）', () => {
    // ⚠️ 不是"实测发现静默失效"——官方文档明确写了 Not supported。
    //    能力表的作用是发请求前拦住，避免用户以为 AI 看了图。
    expect(capabilitiesOf('deepseek-v4-pro').supportsVision).toBe(false);
  });

  it('deepseek-flash 支持视觉（官方文档 ✓）', () => {
    expect(capabilitiesOf('deepseek-flash').supportsVision).toBe(true);
  });

  it('★ 未知模型按保守默认（不支持视觉）', () => {
    const c = capabilitiesOf('某个没见过的模型');
    expect(c.supportsVision).toBe(false);
    // 但流式与工具是可安全假设的
    expect(c.supportsStreaming).toBe(true);
  });

  it('保守默认常量本身是"全不支持"', () => {
    expect(CONSERVATIVE_CAPABILITIES.supportsVision).toBe(false);
    expect(CONSERVATIVE_CAPABILITIES.supportsStreaming).toBe(false);
  });

  it('★ 已知模型清单**只含官方在售的模型**', () => {
    expect(knownModels().length).toBeGreaterThan(0);
    expect(knownModels()).toContain('deepseek-flash');
    expect(knownModels()).toContain('deepseek-v4-pro');
    // ⚠️ 已下线的模型不该在清单里 —— 留着会让用户选到一个用不了的模型
    expect(knownModels()).not.toContain('deepseek-chat');
  });
});

describe('④ ★ 多模态信息进记忆（增分点）', () => {
  const parsed = (fields: Record<string, string>): ParsedAttachment => ({
    attachmentId: 'att_1',
    kind: 'receipt',
    fields,
    summary: '一张超市收据',
    model: 'deepseek-chat',
    usage: { inputTokens: 800, outputTokens: 120 },
  });

  it('★ 品牌字段 → 偏好候选', () => {
    const cands = extractMemoryCandidates({ parsed: parsed({ 品牌: '品牌A' }) });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.kind).toBe('preference');
    expect(cands[0]?.content).toContain('品牌A');
  });

  it('金额与日期 → 事实候选', () => {
    const cands = extractMemoryCandidates({
      parsed: parsed({ 总价: '58.00', 日期: '2026-10-13' }),
    });
    expect(cands).toHaveLength(2);
    expect(cands.every((c) => c.kind === 'fact')).toBe(true);
  });

  it('★★ 置信度偏低（推断证据弱于用户直接陈述）', () => {
    const cands = extractMemoryCandidates({ parsed: parsed({ 品牌: '品牌A' }) });
    expect(cands[0]?.confidence).toBeLessThanOrEqual(0.5);
    expect(cands[0]?.rationale).toContain('弱于用户直接陈述');
  });

  it('★ 带证据链（可追溯到具体附件与字段）', () => {
    const cands = extractMemoryCandidates({ parsed: parsed({ 品牌: '品牌A' }) });
    expect(cands[0]?.evidence).toContain('attachment:att_1');
    expect(cands[0]?.evidence.join(',')).toContain('品牌');
  });

  it('★ 不相关的字段不进记忆（隐私边界）', () => {
    const cands = extractMemoryCandidates({
      parsed: parsed({ 收据编号: 'NO-12345', 收银员: '张三', 品牌: '品牌A' }),
    });
    // 只有品牌那条
    expect(cands).toHaveLength(1);
    expect(JSON.stringify(cands)).not.toContain('张三');
  });

  it('过长或空值被丢弃', () => {
    const cands = extractMemoryCandidates({
      parsed: parsed({ 品牌: '', 商家: 'x'.repeat(100) }),
    });
    expect(cands).toHaveLength(0);
  });

  it('没有可用字段时返回空数组', () => {
    expect(extractMemoryCandidates({ parsed: parsed({}) })).toHaveLength(0);
  });

  it('英文键名同样识别', () => {
    const cands = extractMemoryCandidates({
      parsed: parsed({ brand: 'BrandA', total: '58' }),
    });
    expect(cands.length).toBeGreaterThanOrEqual(1);
  });

  it('★★ 同一规则命中多个同义字段 → 只产出一条（真实调用抓到过重复）', () => {
    /**
     * ⚠️ 真实场景：模型同时给了 `merchant: "STARBUCKSCOFFEE"` 与 `brand: "Starbucks"`，
     *    两者都匹配规则 `品牌|商家|brand|merchant`，修之前会产出**两条**"常购品牌"。
     *    方案 §5.3 预期的是一条。
     */
    const cands = extractMemoryCandidates({
      parsed: parsed({ merchant: 'STARBUCKSCOFFEE', brand: 'Starbucks' }),
    });
    const brandCands = cands.filter((c) => c.content.startsWith('常购品牌'));
    expect(brandCands).toHaveLength(1);
  });

  it('★★ 取值确定：值更短优先（干净的品牌名压过 OCR 拼串）', () => {
    const cands = extractMemoryCandidates({
      parsed: parsed({ merchant: 'STARBUCKSCOFFEE', brand: 'Starbucks' }),
    });
    expect(cands[0]?.content).toBe('常购品牌：Starbucks');
  });

  it('★★ 与模型给出的键顺序无关（重跑结果一致）', () => {
    const a = extractMemoryCandidates({
      parsed: parsed({ merchant: 'STARBUCKSCOFFEE', brand: 'Starbucks' }),
    });
    const b = extractMemoryCandidates({
      // 顺序反过来
      parsed: parsed({ brand: 'Starbucks', merchant: 'STARBUCKSCOFFEE' }),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('★ 合并时在理由里说明（用户看得出为什么只有一条）', () => {
    const cands = extractMemoryCandidates({
      parsed: parsed({ merchant: 'STARBUCKSCOFFEE', brand: 'Starbucks' }),
    });
    expect(cands[0]?.rationale).toContain('已合并');
  });
});

describe('⑤ 上限（防御性）', () => {
  it('正常附件通过', () => {
    expect(checkLimits([{ sizeBytes: 1024 }, { sizeBytes: 2048 }]).ok).toBe(true);
  });

  it('★ 超过个数上限被拒', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ sizeBytes: 100 }));
    const r = checkLimits(many);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('最多');
  });

  it('★ 单文件超过 32 MiB 被拒', () => {
    const r = checkLimits([{ sizeBytes: MAX_IMAGE_BYTES + 1 }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('上限');
  });

  it('★★ 总量按 base64 膨胀后计算（官方限制的是请求体大小）', () => {
    // ⚠️ 必须用**多个**文件才能触发总量检查 ——
    //    单文件检查在前，一张 40 MiB 的图会先被「单个上限」拦下（实测踩过，
    //    测试期望写的是"附件总量"，实际报的是"单个文件超过 32 MiB"）。
    //    4 × 13 MiB 内联后约 69 MiB > 48 MiB 上限。
    const per = 13 * 1024 * 1024;
    const r = checkLimits([
      { sizeBytes: per },
      { sizeBytes: per },
      { sizeBytes: per },
      { sizeBytes: per },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('附件总量');
  });

  it('单文件恰好 32 MiB 可以通过单文件检查', () => {
    expect(checkLimits([{ sizeBytes: MAX_IMAGE_BYTES }]).ok).toBe(true);
  });
});
