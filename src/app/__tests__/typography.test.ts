/**
 * 内容排版分类的测试
 *
 * ★ 为什么这类逻辑特别需要测试：
 *   排版误判**不会报错**，只表现为"看起来别扭"。没有测试的话，
 *   只能靠人眼一行行看 —— 而人眼会漏。
 *
 * ★ 下面的语料**全部来自真实模型输出**（实测一次"周末请朋友吃饭"对话），
 *   不是编出来的例子。编出来的例子永远比真实输出干净，
 *   而真实的模型输出才是要处理的东西。
 */

import { describe, expect, it } from 'vitest';

import { classifyLine, classifyLines, stripBold } from '../typography.js';

// ═══════════════════════════════════════════════════════════
// 用户明确点名的两个例子
// ═══════════════════════════════════════════════════════════

describe('用户点名的两个例子', () => {
  it('★【菜单】判为一级标题（标粗 + 标大）', () => {
    const l = classifyLine('【菜单】');
    expect(l.kind).toBe('major');
    expect(l.text).toBe('菜单');
  });

  it('★「能量估算」判为二级标题（标粗不标大）', () => {
    const l = classifyLine('**能量估算**');
    expect(l.kind).toBe('minor');
    expect(l.text).toBe('能量估算');
  });

  it('★ 标题与正文同行时拆开 —— 否则整行加粗等于没强调', () => {
    const l = classifyLine('【菜式方向】两人份、四菜一汤+一主食，全部家常可操作');
    expect(l.kind).toBe('major');
    expect(l.text).toBe('菜式方向');
    expect(l.rest).toBe('两人份、四菜一汤+一主食，全部家常可操作');
  });
});

// ═══════════════════════════════════════════════════════════
// 真实输出的逐行判定
// ═══════════════════════════════════════════════════════════

describe('真实模型输出的分类（人工核对用）', () => {
  const REAL = `两人周末家宴方案（在家做）
【菜式方向】两人份、四菜一汤+一主食，全部家常可操作，单道菜30分钟内可完成
【菜单】
1. 蒜蓉粉丝蒸虾（主菜·海鲜）—— 鲜虾400g、龙口粉丝1小把
2. 黑椒牛柳（主菜·肉）—— 牛里脊300g、洋葱半个
3. 清炒时蔬（素）—— 西兰花1颗或芦笋300g
【食材清单（按采购单位）】
生鲜：鲜虾400g、牛里脊300g、鸡蛋4个
干货调料：龙口粉丝1把、干木耳15g
【能量估算】
约 1800 千卡/两人，蛋白质约 95g。`;

  it('标题行都识别为标题', () => {
    const lines = classifyLines(REAL);
    const majors = lines.filter((l) => l.kind === 'major').map((l) => l.text);
    expect(majors).toContain('菜式方向');
    expect(majors).toContain('菜单');
    expect(majors).toContain('食材清单（按采购单位）');
    expect(majors).toContain('能量估算');
  });

  it('有序列表识别为列表且带编号', () => {
    const lines = classifyLines(REAL);
    const lists = lines.filter((l) => l.kind === 'list');
    expect(lists).toHaveLength(3);
    expect(lists.map((l) => l.listNumber)).toEqual([1, 2, 3]);
    expect(lists[0]?.text).toContain('蒜蓉粉丝蒸虾');
  });

  it('★ 带冒号的正文行**不**被误判为标题', () => {
    const lines = classifyLines(REAL);
    const shengxian = lines.find((l) => l.text.startsWith('生鲜'));
    // "生鲜：鲜虾400g…" 是正文（有冒号但后面有内容，且行很长）
    expect(shengxian?.kind).toBe('body');
  });

  it('★ 段落里的量词行不被误判为标题', () => {
    // 「约 1800 千卡/两人，蛋白质约 95g。」含数字与逗号，是正文
    const lines = classifyLines(REAL);
    const energy = lines.find((l) => l.text.startsWith('约 1800'));
    expect(energy?.kind).toBe('body');
  });

  it('描述摘要可打印（人工核对）', () => {
    const lines = classifyLines(REAL);
    const text = lines.map((l) => `${l.kind}:${l.text}`).join(' | ');
    // 这个断言只是把结果固化下来便于 diff 时看见变化
    expect(text).toContain('major:菜单');
    expect(text).toContain('list:蒜蓉粉丝蒸虾');
  });
});

// ═══════════════════════════════════════════════════════════
// 边界：从严，宁可漏判不可误判
// ═══════════════════════════════════════════════════════════

describe('误判防护（宁可漏判，不可把正文加粗）', () => {
  it('带句号的短句不是标题', () => {
    expect(classifyLine('今天就到这里。').kind).toBe('body');
  });

  it('带问号的不是标题', () => {
    expect(classifyLine('要不要加个汤？').kind).toBe('body');
  });

  it('以"这/那/所以/建议"开头的不是标题', () => {
    expect(classifyLine('这两个人吃刚好').kind).toBe('body');
    expect(classifyLine('所以不需要再加菜').kind).toBe('body');
    expect(classifyLine('建议提前泡发木耳').kind).toBe('body');
  });

  it('超过 18 字的独立行不是标题', () => {
    expect(classifyLine('两人份四菜一汤加一个主食全部家常可操作').kind).toBe('body');
  });

  it('含数字带单位的不是标题', () => {
    expect(classifyLine('约 30 分钟内完成').kind).toBe('body');
    expect(classifyLine('两人份')).toBeTruthy();
    expect(classifyLine('鲜虾 400g').kind).toBe('body');
  });

  it('中间有冒号的不是标题', () => {
    expect(classifyLine('时间：下午三点出发').kind).toBe('body');
  });

  it('★ 行内括号不被误认为标题方括号', () => {
    // 「蒜蓉粉丝蒸虾（主菜·海鲜）」不是标题
    const l = classifyLine('蒜蓉粉丝蒸虾（主菜·海鲜）—— 鲜虾400g');
    expect(l.kind).toBe('body');
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 字段清单：行内列表展开
// ═══════════════════════════════════════════════════════════

describe('字段清单拆成子项（整段里最容易显密的地方）', () => {
  it('★「生鲜：鲜虾400g、牛里脊300g、…」拆成子项', () => {
    const l = classifyLine(
      '生鲜：鲜虾400g、牛里脊300g、鸡蛋4个、嫩豆腐1盒、番茄2个、黄瓜1根、洋葱半个',
    );
    expect(l.kind).toBe('list');
    expect(l.text).toBe('生鲜');
    expect(l.items).toHaveLength(7);
    expect(l.items?.[0]).toBe('鲜虾400g');
  });

  it('★「干货调料：…」同样拆开', () => {
    const l = classifyLine('干货调料：龙口粉丝1把、干木耳15g、黑胡椒碎、蚝油、生抽、香醋');
    expect(l.kind).toBe('list');
    expect(l.text).toBe('干货调料');
    expect(l.items).toHaveLength(6);
  });

  it('顿号不足 3 个 → 不拆（只是顺带提一句）', () => {
    const l = classifyLine('时间：下午三点、四点都可以');
    expect(l.items).toBeUndefined();
  });

  it('标签过长 → 不拆（不是字段，是句子）', () => {
    const l = classifyLine(
      '这道菜需要准备的食材有：鲜虾、牛肉、鸡蛋、豆腐、番茄、黄瓜、洋葱、彩椒',
    );
    expect(l.items).toBeUndefined();
  });

  it('★ 任一项过长 → 不拆（那是句子里的顿号，不是清单）', () => {
    const l = classifyLine(
      '说明：把鲜虾去壳后从背部剖开挑出沙线并用料酒腌制十分钟备用、牛里脊逆纹切薄片、鸡蛋打散、豆腐切块',
    );
    expect(l.items).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 空行折叠与首尾清理
// ═══════════════════════════════════════════════════════════

describe('空行处理', () => {
  it('★ 连续空行折叠成一个（模型常连打两三个）', () => {
    const lines = classifyLines('A\n\n\n\nB');
    expect(lines.filter((l) => l.kind === 'blank')).toHaveLength(1);
  });

  it('首尾空行去掉（间距由容器控制，不由原文决定）', () => {
    const lines = classifyLines('\n\nA\n\n');
    expect(lines[0]?.text).toBe('A');
    expect(lines[lines.length - 1]?.text).toBe('A');
  });
});

// ═══════════════════════════════════════════════════════════
// 其他语法
// ═══════════════════════════════════════════════════════════

describe('其他语法', () => {
  it('Markdown 标题 `## x` 是一级、`#### x` 是二级', () => {
    expect(classifyLine('## 菜单').kind).toBe('major');
    expect(classifyLine('#### 细节').kind).toBe('minor');
  });

  it('分隔线', () => {
    expect(classifyLine('---').kind).toBe('divider');
  });

  it('无序列表（- / * / ·）', () => {
    expect(classifyLine('- 糙米 300g').kind).toBe('list');
    expect(classifyLine('* 北豆腐 2 盒').kind).toBe('list');
    expect(classifyLine('· 西兰花').kind).toBe('list');
  });

  it('整行加粗带正文时拆开', () => {
    const l = classifyLine('**注意**：木耳要提前泡发');
    expect(l.kind).toBe('minor');
    expect(l.text).toBe('注意');
    expect(l.rest).toBe('木耳要提前泡发');
  });

  it('stripBold 去掉标记保留文字', () => {
    expect(stripBold('**能量估算**')).toBe('能量估算');
    expect(stripBold('前**中**后')).toBe('前中后');
  });
});
