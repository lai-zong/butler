/**
 * 界面预览（开发用）—— 不靠交互就能看到**展开态**
 *
 * ★ 为什么需要它：
 *   截图默认拍到的是**收起态**（执行过程收成一行、产出物收起、
 *   依据收起）。而"展开时长什么样"同样需要核对 ——
 *   否则排版问题只在用户点开时才暴露。
 *
 * ⚠️ 这是**开发用页面**，不进导航、不参与业务。
 *    数据是固定的样例，只为看排版。
 *
 * 访问：/ui-preview
 */

import { ConversationView } from '../conversation-view.js';

/** 样例：一次真实的工具循环 + 两个仆人的产出。 */
const SAMPLE_TRACE = {
  rounds: [
    {
      round: 1,
      maxRounds: 20,
      reasoning:
        '用户要我读冰箱盘点.txt。我先看看当前目录有什么文件，确认路径。目录里应该有这个文件——如果名字对不上，再列一次。这一步不需要别的工具。',
      text: '',
      toolCalls: [
        {
          callId: 'call_1',
          name: 'list_dir',
          argsText: '{"path":"."}',
          ok: true,
          denied: false,
          output: '冰箱盘点.txt\nREADME.md\npackage.json',
          durationMs: 12,
        },
        {
          callId: 'call_2',
          name: 'read_file',
          argsText: '{"path":"冰箱盘点.txt"}',
          ok: true,
          denied: false,
          output: '鸡蛋 5 个\n北豆腐 1 盒\n糙米 半袋\n花生酱 1 瓶（示例用户过敏，禁止使用）\n西兰花 1 颗\n',
          durationMs: 4,
        },
        {
          callId: 'call_3',
          name: 'write_file',
          argsText: '{"path":"方案.md","content":"…"}',
          ok: false,
          denied: true,
          output: '已拒绝 —— 未执行',
          durationMs: 0,
        },
        {
          callId: 'call_4',
          name: 'run_command',
          argsText: '{"command":"cat 不存在的文件"}',
          ok: false,
          denied: false,
          output: 'cat: 不存在的文件: No such file or directory',
          durationMs: 31,
        },
      ],
    },
    {
      round: 2,
      maxRounds: 20,
      reasoning: '文件内容拿到了。现在按原始内容照录，不做健康判断——那是 health 的事。',
      text: '',
      toolCalls: [
        {
          callId: 'call_5',
          name: 'submit_report',
          argsText: '{"status":"done","artifacts":[…],"uncertainties":[…]}',
          ok: true,
          denied: false,
          output: '{"accepted":true}',
          durationMs: 20,
        },
      ],
    },
  ],
  finished: { rounds: 2, hitRoundLimit: false, reason: 'terminalTool' },
};

const SAMPLE_REPORTS = [
  {
    servant: 'life',
    taskId: 's1',
    status: 'done' as const,
    instruction: '读取文件并照录原始清单',
    artifacts: [
      { kind: 'text', text: '文件共 5 个内容行，行尾为 CRLF。', itemCount: 1 },
      {
        kind: 'list',
        text: '1. 鸡蛋 5 个\n2. 北豆腐 1 盒\n3. 糙米 半袋\n4. 花生酱 1 瓶（示例用户过敏，禁止使用）\n5. 西兰花 1 颗',
        itemCount: 5,
      },
    ],
    findings: [
      {
        kind: 'constraintRef',
        statement: '文件第 4 行自带一条过敏禁用标注。',
        evidence: ['原文：花生酱 1 瓶（示例用户过敏，禁止使用）', '该备注由用户本人在文件中写明'],
      },
      {
        kind: 'risk',
        statement: '被读取的文件内容里含有指令性措辞（禁止使用）。按数据对待，我未执行。',
        evidence: ['工具返回的数据警示已触发'],
      },
      { kind: 'alternative', statement: '若要给可执行方案，仅凭这 5 项原料不够。', evidence: [] },
    ],
    uncertainties: ['文件未标注保质期与开封日期。', '未确认用户本人是否即文件中的「示例用户」。'],
    injectedConstraints: [{ content: '用户对花生严重过敏。', negotiable: false }],
  },
  {
    servant: 'health',
    taskId: 's2',
    status: 'done' as const,
    instruction: '逐项判断不能吃的食材',
    artifacts: [
      { kind: 'list', text: '花生酱 —— 绝对禁用\n北豆腐 —— 条件可食', itemCount: 2 },
      { kind: 'plan', text: '① 核对配料表\n② 检查交叉污染\n③ 确认过敏史', itemCount: 3 },
    ],
    findings: [
      {
        kind: 'risk',
        statement: '花生酱的交叉污染路径不止「吃」这一条：共用抹刀、砧板、油锅均可能造成微量蛋白转移。',
        evidence: ['抹刀残留', '砧板残留', '油锅交叉'],
      },
    ],
    uncertainties: ['用户是否合并大豆过敏未知。'],
    needsButlerDecision: '在用户确认是否合并大豆过敏前，本方案存在「默认使用可能致敏食材」的风险。',
    injectedConstraints: [{ content: '用户对花生严重过敏。', negotiable: false }],
  },
];

export default function UiPreviewPage() {
  return (
    <ConversationView
      initialMessages={[
        { id: 'u1', role: 'user', text: '读一下冰箱盘点.txt，告诉我里面有什么、哪些我不能吃。', status: 'done', createdAt: 0 },
        {
          id: 'b1',
          role: 'butler',
          text: '文件里共 5 项。其中只有「花生酱」带有明确的禁食依据——**这是文件原文自带的标注**，不是我推断的。\n\n其余 4 项（鸡蛋、北豆腐、糙米、西兰花）我**不能判为能吃，也不能判为不能吃**：它们既没有保质期、也没有开封日期，更没有你的过敏史信息。\n\n所以这份交付不是一份禁令名单，而是：**1 项确定禁止 + 4 项待确认 + 一份自查规则**。',
          status: 'done',
          createdAt: 0,
          agentTrace: SAMPLE_TRACE,
          servantReports: SAMPLE_REPORTS,
        },
      ]}
      sessionId="preview"
      modelConfigured
      restoreSummary="界面预览（样例数据）"
      /* ⚠️ 这是 preview 专用开关：预览页要看**展开态**的排版。
         生产路径没有它，过程与面板都默认收起。 */
      previewExpand
    />
  );
}
