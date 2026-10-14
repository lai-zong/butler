/**
 * 仆人身份与职责边界
 *
 * 设计依据：参赛方案 v6.5 § 2.1
 *
 * ⚠️ 编排原则：**五个仆人完全平等，唯一裁决者是管家。**
 *    仆人只提交 findings（发现 + 证据），不做裁决、不排序、不判定严重性。
 *    硬约束的拦截由管家校验层机械执行，不是某个仆人的权力。
 */

// ═══════════════════════════════════════════════════════════
// 仆人身份
// ═══════════════════════════════════════════════════════════

export type ServantId = 'life' | 'health' | 'study' | 'work' | 'code';

export const SERVANT_IDS: readonly ServantId[] = ['life', 'health', 'study', 'work', 'code'];

/**
 * 职责边界 —— 防重合的依据（答辩可直接引用）。
 *
 * 边界测试法：**这个决定的核心依据是"方便/划算"，还是"对身体好不好"？**
 * 注意「选择」与「评价」是两件事：生活仆人负责选，健康仆人负责评价。
 */
export const SERVANT_BOUNDARY: Record<ServantId, { name: string; domain: string; test: string }> = {
  life: {
    name: '生活仆人',
    domain: '外部世界的资源获取',
    test: '去哪、买什么、怎么去',
  },
  health: {
    name: '健康仆人',
    domain: '身体与习惯的约束和分析（含营养 / 运动 / 作息）',
    test: '能不能、该不该、多少量',
  },
  study: {
    name: '学习仆人',
    domain: '知识获取、技能训练、资料整理',
    test: '学什么、怎么练',
  },
  work: {
    name: '办公仆人',
    domain: '文档、日程、会议、文件整理',
    test: '写什么、安排在哪天',
  },
  code: {
    name: '代码仆人',
    domain: '编程、调试、脚本、自动化',
    test: '怎么实现、怎么自动化',
  },
};

/**
 * 领域推理框架 —— 每个仆人的"专业方法"。
 *
 * ★ 为什么需要它：
 *   光有一个领域标签（"你是生活仆人"），模型给出的建议是**泛泛的**。
 *   给它一套该领域的检查清单，它才会像专业人士那样思考 ——
 *   健康仆人按营养学框架核对，办公仆人按公文规范检查。
 *
 * 注意措辞纪律（方案 § 6.2）：这些是**该领域的通用专业方法**，
 * 不是本项目发明的理论。写进 prompt 是为了让输出达到专业水准。
 */
export const SERVANT_REASONING: Record<ServantId, readonly string[]> = {
  life: [
    '先确认场合与人数，再谈方案 —— 家宴、外出、送礼的取舍完全不同',
    '资源方案要给出**可执行细节**：具体名称、数量、时间、渠道',
    '比价与距离要落到量级（人均多少、多远、多久），不给模糊形容',
    '考虑同行人的特殊情况（忌口、行动不便、带小孩），主动核对而不是等提醒',
    '方案要有备选：首选不成立时给替代项，并说明取舍理由',
  ],
  health: [
    '先明确目标与基线（增肌 / 减脂 / 维持；当前量与目标量差多少）才是可判断的',
    '营养核对按**成分**看：能量、蛋白质、脂肪（尤其饱和脂肪）、钠、膳食纤维',
    '注意"隐形来源"：复合调味料、酱料、预包装食品、外食烹饪用油',
    '给出**量化区间**而不是形容词（"油 ≤ 5g/人/餐"，不是"少油"）',
    '识别冲突与风险：过敏原、药物相互作用、特殊人群禁忌',
    '趋势比单点重要：一次超标不等于问题，连续三周才值得提示',
  ],
  study: [
    '先定位当前水平与目标差距，再决定学什么 —— 跳过前置知识是常见失败原因',
    '学习材料要分层：概念入门 → 动手练习 → 边界情况',
    '给出**可检验的练习**，而不只是知识点罗列',
    '注意遗忘曲线：同一主题安排复习节点，而不是一次讲完',
    '资料整理要有结构（主题 / 难度 / 前置依赖），便于后续检索',
  ],
  work: [
    '先明确文档的**读者与用途**（给谁看、看完要做什么决定），再定结构',
    '会议与日程要落到具体时间点与时长，并标注依赖关系',
    '文档结构：结论先行 → 依据 → 待决事项，避免流水账',
    '整理类任务先给分类维度，再往里填内容',
    '时间安排要预留缓冲，不要把日程排满',
  ],
  code: [
    '先读现有代码与约定，再动手 —— 不假设项目结构',
    '改动前先确认影响范围；能小改就不大改',
    '优先走程序化路径（API / CLI）；没有接口时才考虑模拟操作',
    '每步操作后校验结果（退出码、文件是否生成、测试是否通过）',
    '出错时先看完整报错与环境，不要凭猜测反复试',
    '输出要说明"改了什么、为什么、怎么验证"',
  ],
};

/**
 * 归属判定辅助：给出场景描述，返回最可能的仆人。
 *
 * 注意：这只是**启发式提示**，真正的路由由管家的路由决策完成，
 * 且置信度不足时必须询问用户（§ 2.2①）。
 */
export function suggestServant(scenario: string): { servant: ServantId; confidence: number } | null {
  const s = scenario.toLowerCase();
  const rules: ReadonlyArray<readonly [ServantId, readonly string[]]> = [
    ['health', ['营养', '热量', '运动', '作息', '睡眠', '过敏', '体检', '减脂', '健康', '饮食禁忌']],
    ['life', ['餐厅', '出行', '采购', '订票', '酒店', '买', '比价', '聚会', '行程']],
    ['code', ['代码', '调试', '脚本', '自动化', 'bug', '编译', '部署', '函数']],
    ['work', ['文档', '会议', '纪要', '日程', '邮件', '文件整理', '周报']],
    ['study', ['学习', '课程', '练习', '知识', '笔记', '考试', '资料']],
  ];
  for (const [servant, keywords] of rules) {
    if (keywords.some((k) => s.includes(k))) {
      return { servant, confidence: 0.7 };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// 任务分解与派发
// ═══════════════════════════════════════════════════════════

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 注入给某个仆人的约束（§ 2.2⑥ 第 ③ 步，可审计）。 */
export interface InjectedConstraint {
  readonly memoryId: string;
  readonly content: string;
  readonly source: 'global_constraint' | 'global_shared' | 'sensitive' | 'domain';
  /** 硬约束不可协商；软约束冲突时上报用户裁决 */
  readonly negotiable: boolean;
}

/** 上游步骤传给本步骤的产出物（方案 § 2.2① 依赖关系的实际语义）。 */
export interface UpstreamInput {
  readonly stepId: string;
  readonly servant: string;
  readonly artifacts: readonly ServantArtifact[];
  /** 上游的发现（仅陈述，不含裁决） */
  readonly findings: readonly Finding[];
}

export interface DispatchStep {
  readonly stepId: string;
  readonly servant: ServantId | 'butler';
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly status: StepStatus;
  /** 管家按任务相关性注入，而非仆人读取全部记忆 */
  readonly injectedConstraints: readonly InjectedConstraint[];
  /**
   * 依赖步骤的产出物。
   *
   * ⚠️ 没有这个字段，"依赖"就只是**顺序控制**，下游拿不到上游做出来的东西——
   *    实测表现为：健康仆人声称"未收到菜单原文，无法独立复核"，
   *    于是它只能声明风险而无法真正审核（由监督层 crossServant 检出）。
   */
  readonly inputs?: readonly UpstreamInput[];
  readonly report?: ServantReport;
}

export interface Dispatch {
  readonly id: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly decomposition: readonly DispatchStep[];
  /** 路由置信度。低于阈值时转入澄清提问（route.clarify） */
  readonly routingConfidence: number;
  readonly createdAt: number;
}

/** 路由置信度阈值：低于此值不猜测，转为询问用户。 */
export const ROUTING_CONFIDENCE_THRESHOLD = 0.6;

// ═══════════════════════════════════════════════════════════
// 仆人汇报
// ═══════════════════════════════════════════════════════════

/**
 * 仆人提交的"发现"。
 *
 * ⚠️ **没有 severity 决定权，也没有否决权** —— 判定与拦截由管家校验层执行。
 * 这是"仆人完全平等"在类型层面的体现。
 */
export interface Finding {
  readonly kind: 'constraintRef' | 'risk' | 'alternative';
  readonly statement: string;
  readonly evidence: readonly string[];
  /** 指向全局约束 id，供管家机械校验 */
  readonly constraintRef?: string;
}

export interface ServantReport {
  readonly taskId: string;
  readonly servant: ServantId;
  readonly status: 'done' | 'failed' | 'blocked';
  readonly artifacts: readonly ServantArtifact[];
  /** 本次用到了哪些记忆（可审计） */
  readonly memoryRefs: readonly string[];
  /** 诚实声明不确定的地方，而不是硬着头皮给答案 */
  readonly uncertainties: readonly string[];
  /** 需要管家裁决的问题 */
  readonly needsButlerDecision?: string;
  /** 只提交发现，不做裁决 */
  readonly findings?: readonly Finding[];
}

export type ServantArtifact =
  | { readonly kind: 'text'; readonly content: string }
  | { readonly kind: 'list'; readonly content: readonly string[] }
  | { readonly kind: 'plan'; readonly content: readonly string[] }
  | { readonly kind: 'file'; readonly content: { readonly name: string; readonly ref: string } };

// ═══════════════════════════════════════════════════════════
// 冲突
// ═══════════════════════════════════════════════════════════

export type ConflictKind =
  | 'crossServant' // 跨领域建议矛盾
  | 'memoryInconsistency' // 新旧记忆矛盾
  | 'principleViolation' // 违背已生效原则
  | 'omission'; // 遗漏关键约束

export type ConflictSeverity = 'info' | 'warn' | 'block';

export type ConflictResolution =
  | { readonly kind: 'askUser' }
  | { readonly kind: 'autoResolved'; readonly by: string; readonly reason: string }
  | { readonly kind: 'dismissed'; readonly by: string; readonly reason: string }
  | { readonly kind: 'hardBlocked'; readonly constraintId: string; readonly reason: string };

export interface MemoryConflict {
  readonly id: string;
  readonly kind: ConflictKind;
  readonly severity: ConflictSeverity;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly parties?: readonly ServantId[];
  readonly resolution: ConflictResolution;
}
