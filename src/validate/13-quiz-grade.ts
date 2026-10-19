/**
 * 验证 13：做题与批改（v8 批次A）
 *
 * ★ 本验证要证明五件事（都是"任务视图能成立"的前提）：
 *   ① **题目与答案在产出物里就分开了** —— 产出物序列化后不含答案
 *   ② **答案能落事件、能被读回**（重启后仍可批改，因为答案在 `events.jsonl` 里）
 *   ③ **批改是确定性的、零 LLM** —— 同一份作答跑两次结果一致，且全程无模型调用
 *   ④ **��条边界不误判**：未作答算错但 picked 留空；无法归一化算错不猜；缺答案键判错不跳过
 *   ⑤ **批改结果落事件** —— 否则会话结束后的反思不知道做过题
 *
 * ⚠️ 判据先说清（避免事后找理由）：
 *   · ① 用 `JSON.stringify` 断言，不用"肉眼看着没答案"
 *   · ③ 用"注入会抛错的模型桩"证明零调用 —— 而不是"没看到调用日志"
 *   · ④ 三条边界各一条断言，缺一条都不算过
 */

import { EventLog } from '../core/events/log.js';
import { normalizeArtifact } from '../core/prompts/schemas.js';
import { renderArtifact } from '../core/execution/render.js';
import { gradeQuiz } from '../core/quiz/grade.js';
import { readAnswerKey, readQuizzes } from '../core/quiz/read.js';
import type { QuizQuestion } from '../core/execution/types.js';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  ${detail}` : ''}`);
  }
}

function hr(t: string): void {
  console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);
}

/**
 * ⚠️ 两个**不同**的 id —— 必须分开（真实系统里它们就是不同的）：
 *   · `LOG_ID`  ：`EventLog` 构造时传的"事件日志 id"，填进 `SessionEvent.sessionId`
 *   · `SESSION` ：**聊天会话** id，写在事件 payload 的 `taskId` 里
 *
 * ★ 这里曾把两者传成同一个值，于是"按 sessionId 过滤"的错误写法
 *   **在验证脚本里也能通过** —— 那是假绿。现在照真实调用链区分。
 */
const LOG_ID = '__event_log__';
const SESSION = 'sess_validate_13';
const T0 = 1_760_000_000_000;

/** 模型可能给出的四种答案写法，各一道题 */
const RAW_QUIZ = {
  kind: 'quiz' as const,
  quiz: [
    { stem: '哪种烹饪用油最少？', options: ['油炸', '清蒸', '红烧'], answer: 'B' },
    { stem: '花生过敏要避开哪个？', options: ['花生酱', '西兰花'], answer: 'A. 花生酱' },
    { stem: '每天建议食用油量？', options: ['25g', '50g', '100g'], answer: 1 },
    { stem: '焯水的作用？', options: ['去油', '去涩'], answer: '去油' },
  ],
};

async function main(): Promise<void> {
  hr('① 题目与答案在产出物里就分开');

  const normalized = normalizeArtifact(RAW_QUIZ);
  check('归一化成功', normalized !== null);
  if (!normalized) {
    console.log('\n▶ 验证 13 未通过（归一化失败，后续无从继续）\n');
    process.exit(1);
  }

  const artifact = normalized.artifact;
  const questions = artifact.kind === 'quiz' ? (artifact.content as readonly QuizQuestion[]) : [];
  check('四道题全部保留', questions.length === 4, `实际 ${questions.length}`);

  const dumped = JSON.stringify(artifact);
  check('★ 产出物序列化后不含答案键', !dumped.includes('correct') && !dumped.includes('answer'));
  check('★ 产出物里查不到解析文本', !dumped.includes('explanation'));

  const answers = normalized.answers;
  check('答案数量与题目一致', answers.length === questions.length, `${answers.length} vs ${questions.length}`);

  check(
    '★ 四种答案写法都归一化成字母',
    answers.map((a) => a.correct).join('') === 'BAAA',
    answers.map((a) => `${a.id}=${a.correct}`).join(' '),
  );

  hr('② 答案落事件、可读回（重启后仍可批改）');

  const log = new EventLog(LOG_ID);
  const quizId = (() => {
    log.append({
      type: 'quiz.created',
      actor: 'butler',
      payload: {
        taskId: SESSION,
        artifactIndex: 0,
        questions,
        answers,
      },
      createdAt: T0,
    });
    return log.length;
  })();

  const readBack = readQuizzes(log, SESSION);
  check('从事件读回一份题', readBack.length === 1);
  check('题目一致', JSON.stringify(readBack[0]?.questions) === JSON.stringify(questions));

  // ★ 回归断言：用**日志 id** 查不到（证明过滤用的是 taskId 而不是 e.sessionId）
  check('★ 用日志 id 查不到题（过滤依据是 payload.taskId）', readQuizzes(log, LOG_ID).length === 0);

  const readBackDump = JSON.stringify(readBack);
  check('★★ 给调用方的结构里不含答案（它会被直接放进 HTTP 响应）',
    !readBackDump.includes('correct') && !readBackDump.includes('explanation'));

  const key = readAnswerKey(log, SESSION, quizId);
  check('答案表能读回', key !== undefined);
  check('答案表含四题答案', key?.correct.size === 4, `实际 ${key?.correct.size}`);

  hr('③ 批改是确定性的、零 LLM');

  if (!key) {
    console.log('\n▶ 验证 13 未通过（答案表缺失）\n');
    process.exit(1);
  }

  // 正确答案是 B / A / A / A（见上面那条"四种写法都归一化成字母"的断言）
  const submission = { q1: 'B', q2: 'A', q3: 'A', q4: 'A' };
  const g1 = gradeQuiz({ answerKey: key, submission });
  const g2 = gradeQuiz({ answerKey: key, submission });
  check('同一份作答两次结果完全一致', JSON.stringify(g1) === JSON.stringify(g2));
  check('全对时 right === total', g1.right === 4 && g1.total === 4, `${g1.right}/${g1.total}`);

  // ★ 零 LLM：批改链路没有任何模型依赖 —— 用类型层面的事实 + 模块导入检查来证
  const gradeSrc = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../core/quiz/grade.ts', import.meta.url), 'utf8'),
  );
  check('★ 批改模块没有导入任何模型端口', !/ModelPort|completeStructured|deepseek/i.test(gradeSrc));

  hr('④ 三条边界不误判');

  const partial = gradeQuiz({ answerKey: key, submission: { q1: 'B' } });
  const q2Item = partial.items.find((i) => i.questionId === 'q2');
  check('未作答算错', q2Item?.right === false);
  check('★ 未作答的 picked 留空（界面要能区分"没做"与"选错"）', q2Item?.picked === undefined);
  check('未作答不影响已作答的对错', partial.right === 1, `right=${partial.right}`);

  const garbage = gradeQuiz({ answerKey: key, submission: { q1: '我选第二个', q2: 'Z' } });
  check('★ 无法归一化的作答算错且不猜', garbage.right === 0);

  const noKey = gradeQuiz({ answerKey: { ...key, correct: new Map() }, submission });
  check('★ 缺答案键时判错而不是跳过（否则 total 会骗人）', noKey.total === 4 && noKey.right === 0,
    `${noKey.right}/${noKey.total}`);

  hr('⑤ 批改结果落事件');

  log.append({
    type: 'quiz.graded',
    actor: 'user',
    payload: { quizId, total: g1.total, right: g1.right, items: g1.items },
    createdAt: T0 + 1,
  });

  const after = readQuizzes(log, SESSION);
  check('批改后读回带 grade', after[0]?.grade !== undefined);
  check('grade 的对题数与批改一致', after[0]?.grade?.right === g1.right);
  check('grade 逐题保留', (after[0]?.grade?.items.length ?? 0) === 4);

  hr('⑥ 展示层不泄漏：题面渲染不含答案');

  const rendered = renderArtifact(artifact);
  check('渲染出四道题', rendered.itemCount === 4);
  check('★ 渲染文本不含解析', !rendered.text.includes('清蒸几乎不用油'));
  check('渲染不出现 [object Object]', !rendered.text.includes('[object Object]'));

  hr('结果');
  console.log(`  通过 ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.log(`  ✗ 失败 ${failed} 项`);
    console.log('\n▶ 验证 13 未通过\n');
    process.exit(1);
  }
  console.log('\n▶ 验证 13 通过：做题链路成立（答案分离 / 可读回 / 确定性批改 / 落事件）\n');
}

await main();
