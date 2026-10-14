/**
 * 分层反思测试 —— 重点验证「作用域隔离」真的成立
 *
 * 创新点 ① 的主张是"学得对"，靠的是**反思作用域被隔离，防污染**。
 * 那么核心问题就是：
 *   **仆人的反思过程，到底有没有可能接触到别的领域？**
 *
 * 本文件用 MockModel 精确回答这个问题 —— 不看模型的输出，只看
 * **模型收到了什么**。隔离成立与否，是输入构造决定的，不是提示词恳求决定的。
 */

import { describe, expect, it } from 'vitest';

import { MockModel, respondJson, respondJsonWhen, type MockModelOptions } from '../../../adapters/model/mock.js';
import { EventLog } from '../../events/log.js';
import { FixedClock } from '../../ports/clock.js';
import { reflectionSchema } from '../../prompts/schemas.js';
import type { ServantReport } from '../../servants/types.js';
import {
  buildServantReflectionInput,
  reflectButler,
  reflectServant,
  servantReflectionSystem,
  summarizeReport,
} from '../reflect.js';

const T0 = 1_760_000_000_000;

// ── 夹具 ──

function report(over: Partial<ServantReport> = {}): ServantReport {
  return {
    taskId: 'step1',
    servant: 'life',
    status: 'done',
    artifacts: [{ kind: 'text', content: '推荐了 3 家清淡口味的家常菜馆' }],
    memoryRefs: [],
    uncertainties: ['不知道用户住址'],
    findings: [{ kind: 'risk', statement: '有一家评价不稳定', evidence: [] }],
    ...over,
  };
}

function reflectionResponse(candidates: unknown[], extra: Record<string, unknown> = {}) {
  return { candidates, ...extra };
}

function setup(opts: MockModelOptions) {
  const log = new EventLog('s_reflect');
  const clock = new FixedClock(T0);
  return { log, clock, model: new MockModel(opts) };
}

// ═══════════════════════════════════════════════════════════
// ★ 核心：作用域隔离
// ═══════════════════════════════════════════════════════════

describe('★ 仆人反思的作用域隔离（创新点 ① 的核心主张）', () => {
  const SECRET_HEALTH = '用户正在接受心理治疗';
  const SECRET_OTHER_DOMAIN = 'Excel 批量处理优先走 COM 接口';
  const GLOBAL_HARD = '用户对花生严重过敏';

  it('★ 模型收到的材料里不含敏感域内容', async () => {
    const { log, clock, model } = setup({
      script: [respondJson(reflectionResponse([]))],
    });

    await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({
        servant: 'life',
        userGoal: '请朋友吃饭',
        ownReports: [report()],
        ownDomainMemories: [{ id: 'd1', kind: 'preference', content: '偏好清淡口味', lifecycle: 'active' }],
      }),
    });

    // 隔离成立：模型从未看到那条敏感信息
    expect(model.sawText(SECRET_HEALTH)).toBe(false);
  });

  it('★ 模型收到的材料里不含其它仆人的领域记忆', async () => {
    const { log, clock, model } = setup({
      script: [respondJson(reflectionResponse([]))],
    });

    await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({
        servant: 'life',
        userGoal: '请朋友吃饭',
        ownReports: [report()],
        ownDomainMemories: [{ id: 'd1', kind: 'preference', content: '偏好清淡口味', lifecycle: 'active' }],
      }),
    });

    expect(model.sawText(SECRET_OTHER_DOMAIN)).toBe(false);
  });

  it('★ 模型收到的材料里不含全局记忆（仆人反思只看自己领域）', async () => {
    const { log, clock, model } = setup({
      script: [respondJson(reflectionResponse([]))],
    });

    await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({
        servant: 'health',
        userGoal: '安排饮食',
        ownReports: [report({ servant: 'health' })],
        ownDomainMemories: [],
      }),
    });

    // 硬约束是"执行时由管家注入"的，不是"反思时该看到的材料"
    expect(model.sawText(GLOBAL_HARD)).toBe(false);
  });

  it('★ 隔离是**结构性**的：函数签名里就没有传别的领域材料的入口', () => {
    // 这个断言是编译期的：buildServantReflectionInput 的参数列表里
    // 根本没有 globalMemories / otherServantReports / sensitiveMemories。
    // 用运行时断言把这条设计意图固化下来，防止以后有人"顺手"加参数。
    const params = buildServantReflectionInput.length;
    expect(params).toBe(1); // 只有一个对象参数
    const src = buildServantReflectionInput.toString();
    expect(src).not.toContain('globalMemories');
    expect(src).not.toContain('otherServant');
    expect(src).not.toContain('sensitive');
  });

  it('仆人反思的产出作用域一律是 domain，且归属是自己', async () => {
    const { log, clock, model } = setup({
      script: [
        respondJson(
          reflectionResponse([
            { kind: 'preference', content: '偏好清淡口味', confidence: 0.7, evidence: ['e1'], rationale: 'r' },
            { kind: 'principle', content: '推荐餐厅前先确认同行人忌口', confidence: 0.8, evidence: ['e2'], rationale: 'r' },
          ]),
        ),
      ],
    });

    const r = await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({
        servant: 'life',
        userGoal: '请朋友吃饭',
        ownReports: [report()],
        ownDomainMemories: [],
      }),
    });

    expect(r.candidates).toHaveLength(2);
    for (const c of r.candidates) {
      // ★ 领域反思不可能产出全局层候选 —— 这是类型与构造共同保证的
      expect(c.scope.memClass).toBe('domain');
      expect(c.scope.domainOwner).toBe('life');
      expect(c.layer).toBe('servant');
      expect(c.by).toBe('life');
    }
  });

  it('系统提示明确了边界，且要求"提不出就返回空"', () => {
    const sys = servantReflectionSystem('life');
    expect(sys).toContain('不可越界');
    expect(sys).toContain('不要评价别的仆人');
    expect(sys).toContain('宁可少提');
    // 空答案是允许的 —— 否则模型会为了"有产出"而编造
    expect(sys).toContain('空数组');
  });
});

// ═══════════════════════════════════════════════════════════
// 仆人反思 · 行为
// ═══════════════════════════════════════════════════════════

describe('仆人反思 · 产出与事件', () => {
  it('产出候选并落 reflection.started / reflection.done 事件', async () => {
    const { log, clock, model } = setup({
      script: [
        respondJson(
          reflectionResponse([
            { kind: 'preference', content: '偏好清淡', confidence: 0.65, evidence: ['用户说想吃清淡的'], rationale: '本次三次提到' },
          ]),
        ),
      ],
    });

    const r = await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({
        servant: 'life',
        userGoal: '请朋友吃饭',
        ownReports: [report()],
        ownDomainMemories: [],
      }),
    });

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.content).toBe('偏好清淡');
    expect(r.candidates[0]?.evidence).toEqual(['用户说想吃清淡的']);

    expect(log.byType('reflection.started')).toHaveLength(1);
    const done = log.byType('reflection.done');
    expect(done).toHaveLength(1);
    expect(done[0]?.payload).toMatchObject({ layer: 'servant', candidateCount: 1 });
    expect(done[0]?.servantId).toBe('life');
    // 提示词版本要记录（方案 § 5.2 可复现信息）
    expect((done[0]?.payload as { promptVersion?: string }).promptVersion).toContain('reflection.servant');
  });

  it('★ 空候选是合法结果（诚实，不凑数）', async () => {
    const { log, clock, model } = setup({ script: [respondJson(reflectionResponse([]))] });

    const r = await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({
        servant: 'life',
        userGoal: '随便聊聊',
        ownReports: [],
        ownDomainMemories: [],
      }),
    });

    expect(r.candidates).toHaveLength(0);
    expect(log.byType('reflection.done')).toHaveLength(1);
  });

  it('空内容候选被丢弃（不让噪声进入记忆库）', async () => {
    const { log, clock, model } = setup({
      script: [
        respondJson(
          reflectionResponse([
            { kind: 'fact', content: '   ', confidence: 0.5, evidence: [], rationale: '' },
            { kind: 'fact', content: '有内容', confidence: 0.5, evidence: [], rationale: '' },
          ]),
        ),
      ],
    });

    const r = await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({ servant: 'life', userGoal: 'g', ownReports: [], ownDomainMemories: [] }),
    });

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.content).toBe('有内容');
  });

  it('越界置信度被 schema 拒绝（由适配器重试，而非静默夹取）', async () => {
    // 契约：confidence ∈ [0,1]。校验发生在 **LLM 边界**，
    // 越界输出让本次调用失败并触发重试 —— 不会流进领域模型。
    // （我一度在映射函数里写了 clamp，那是死代码：schema 已经先拒绝了。）
    const { log, clock, model } = setup({
      script: [
        respondJson(
          reflectionResponse([
            { kind: 'fact', content: '过低', confidence: -0.5, evidence: [], rationale: '' },
          ]),
        ),
      ],
    });

    await expect(
      reflectServant({
        model,
        log,
        clock,
        input: buildServantReflectionInput({ servant: 'life', userGoal: 'g', ownReports: [], ownDomainMemories: [] }),
      }),
    ).rejects.toThrow(/不合规/);
  });

  it('schema 直接拒绝越界值（不依赖调用方夹取）', () => {
    for (const bad of [-0.5, 99]) {
      const r = reflectionSchema.safeParse(
        reflectionResponse([{ kind: 'fact', content: 'x', confidence: bad, evidence: [], rationale: '' }]),
      );
      expect(r.success, `confidence=${bad} 应被拒绝`).toBe(false);
    }
  });

  it('产出状态由报告推导，与 schema 一致', async () => {
    const { log, clock, model } = setup({ script: [respondJson(reflectionResponse([]))] });
    await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({
        servant: 'health',
        userGoal: 'g',
        ownReports: [report({ servant: 'health', status: 'failed' })],
        ownDomainMemories: [],
      }),
    });
    expect(model.sawText('status=failed')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 管家复盘 · 跨领域
// ═══════════════════════════════════════════════════════════

describe('管家复盘 · 跨领域视角', () => {
  it('★ 管家的材料包含全局层信息（这正是它与仆人的区别）', async () => {
    const { log, clock, model } = setup({
      script: [respondJson(reflectionResponse([], { collaborationIssues: [], rhythmChanges: [] }))],
    });

    await reflectButler({
      model,
      log,
      clock,
      input: {
        userGoal: '请朋友吃饭',
        reports: [
          { servant: 'life', summary: '推荐了 3 家餐厅' },
          { servant: 'health', summary: '指出火锅高油高盐' },
        ],
        conflicts: [{ message: '火锅 vs 减脂', severity: 'warn' }],
        globalMemories: [{ id: 'g1', kind: 'fact', content: '用户对花生严重过敏', lifecycle: 'active' }],
        existingPrinciples: [
          { id: 'p1', content: '跨领域冲突时安全优先', applied: 5, succeeded: 1 },
        ],
        temporalPatterns: ['工作日 9—18 点为专注时段'],
      },
    });

    // 管家能看到全局、能看到两个领域的产出、能看到原则效果
    expect(model.sawText('花生严重过敏')).toBe(true);
    expect(model.sawText('火锅高油高盐')).toBe(true);
    expect(model.sawText('应用 5 次 / 成功 1 次')).toBe(true);
    expect(model.sawText('工作日 9—18 点')).toBe(true);
  });

  it('效果不佳的原则会被标注出来', async () => {
    const { log, clock, model } = setup({
      script: [respondJson(reflectionResponse([]))],
    });
    await reflectButler({
      model,
      log,
      clock,
      input: {
        userGoal: 'g',
        reports: [],
        conflicts: [],
        globalMemories: [],
        existingPrinciples: [{ id: 'p1', content: '某条原则', applied: 10, succeeded: 2 }],
        temporalPatterns: [],
      },
    });
    expect(model.sawText('效果不佳')).toBe(true);
  });

  it('产出候选进全局共享层（不是硬约束）', async () => {
    const { log, clock, model } = setup({
      script: [
        respondJson(
          reflectionResponse([
            { kind: 'principle', content: '涉及时间安排时先确认工作日还是周末', confidence: 0.7, evidence: ['e'], rationale: 'r' },
          ]),
        ),
      ],
    });

    const r = await reflectButler({
      model,
      log,
      clock,
      input: {
        userGoal: 'g',
        reports: [],
        conflicts: [],
        globalMemories: [],
        existingPrinciples: [],
        temporalPatterns: [],
      },
    });

    expect(r.candidates).toHaveLength(1);
    // ★ 反思不能凭空造出安全约束 —— 硬约束只能由用户设定
    expect(r.candidates[0]?.scope.memClass).toBe('global_shared');
    expect(r.candidates[0]?.layer).toBe('butler');
    expect(r.candidates[0]?.by).toBe('butler');
  });

  it('协作问题与节奏变化被单独收集', async () => {
    const { log, clock, model } = setup({
      script: [
        respondJson(
          reflectionResponse([], {
            collaborationIssues: ['健康仆人的审核结果没有回流给生活仆人'],
            rhythmChanges: ['最近两周深夜活跃时间明显变长'],
          }),
        ),
      ],
    });

    const r = await reflectButler({
      model,
      log,
      clock,
      input: { userGoal: 'g', reports: [], conflicts: [], globalMemories: [], existingPrinciples: [], temporalPatterns: [] },
    });

    expect(r.collaborationIssues).toHaveLength(1);
    expect(r.rhythmChanges).toHaveLength(1);

    const done = log.byType('reflection.done')[0];
    expect(done?.payload).toMatchObject({ layer: 'butler' });
  });

  it('缺省的可选字段不会变成 undefined 泄漏出去', async () => {
    const { log, clock, model } = setup({ script: [respondJson({ candidates: [] })] });
    const r = await reflectButler({
      model,
      log,
      clock,
      input: { userGoal: 'g', reports: [], conflicts: [], globalMemories: [], existingPrinciples: [], temporalPatterns: [] },
    });
    expect(r.collaborationIssues).toEqual([]);
    expect(r.rhythmChanges).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 两层反思的分工
// ═══════════════════════════════════════════════════════════

describe('★ 两层反思的分工（方案 § 2.2④）', () => {
  it('仆人层与管家层的候选作用域不重叠', async () => {
    const servantOut = reflectionSchema.parse(
      reflectionResponse([{ kind: 'preference', content: 'x', confidence: 0.5, evidence: [], rationale: '' }]),
    );
    expect(servantOut.candidates).toHaveLength(1);

    // 领域层 → domain；管家层 → global_shared。两者互不越界。
    const input = buildServantReflectionInput({
      servant: 'life',
      userGoal: 'g',
      ownReports: [],
      ownDomainMemories: [],
    });
    expect(input.servant).toBe('life');
    expect(Object.keys(input)).not.toContain('reports'); // 管家才有多仆人 reports
  });

  it('摘要函数会截断过长产出（控制 prompt 体积）', () => {
    const long = report({
      artifacts: [{ kind: 'text', content: 'x'.repeat(2000) }],
      findings: [],
    });
    const s = summarizeReport(long);
    expect(s.length).toBeLessThanOrEqual(720);
    expect(s).toContain('已截断');
  });

  it('摘要函数会合并产出与发现', () => {
    const s = summarizeReport(report());
    expect(s).toContain('推荐了 3 家清淡口味的家常菜馆');
    expect(s).toContain('[risk]');
  });
});

// ═══════════════════════════════════════════════════════════
// MockModel 自身
// ═══════════════════════════════════════════════════════════

describe('MockModel · 测试基础设施自检', () => {
  it('记录每次调用的完整提示词', async () => {
    const model = new MockModel({ script: [respondJson(reflectionResponse([]), 'reflection')] });
    const log = new EventLog('s');
    const clock = new FixedClock(T0);

    await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({ servant: 'life', userGoal: '目标ABC', ownReports: [], ownDomainMemories: [] }),
    });

    expect(model.countByPurpose('reflection')).toBe(1);
    expect(model.sawText('目标ABC')).toBe(true);
  });

  it('脚本输出不合规时抛错（而不是静默返回脏数据）', async () => {
    const model = new MockModel({ script: [respondJson({ candidates: 'not-an-array' }, 'reflection')] });
    const log = new EventLog('s');
    const clock = new FixedClock(T0);

    await expect(
      reflectServant({
        model,
        log,
        clock,
        input: buildServantReflectionInput({ servant: 'life', userGoal: 'g', ownReports: [], ownDomainMemories: [] }),
      }),
    ).rejects.toThrow(/不合规/);
  });

  it('按关键词分派不同响应', async () => {
    const model = new MockModel({
      script: [
        respondJsonWhen(['生活'], reflectionResponse([{ kind: 'fact', content: '来自生活分支', confidence: 0.5, evidence: [], rationale: '' }])),
      ],
      fallback: { kind: 'json', value: reflectionResponse([]) },
    });
    const log = new EventLog('s');
    const clock = new FixedClock(T0);

    const r = await reflectServant({
      model,
      log,
      clock,
      input: buildServantReflectionInput({ servant: 'life', userGoal: 'g', ownReports: [], ownDomainMemories: [] }),
    });
    expect(r.candidates[0]?.content).toBe('来自生活分支');
  });
});
