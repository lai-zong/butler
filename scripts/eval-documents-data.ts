/**
 * 文档检索评测数据（8 个文档 / 30 条查询）
 *
 * ⚠️ 这里测的是“能否把正确片段排进前 K”，不是端到端问答。
 *    端到端 QA 还需要模型生成与引用核对，不能用本文件冒充。
 */

export interface EvalDocument {
  readonly name: string;
  readonly text: string;
}

export interface EvalDocumentCase {
  readonly q: string;
  /** 检索时命中片段必须包含的字符串（可多个，全部满足才算命中）。 */
  readonly want: readonly string[];
  /**
   * 端到端 QA 的答案关键点；缺省等于 want。
   * 用于“回答可以更短/换否定说法、但语义正确”的情况，而不是放宽检索。
   */
  readonly answerKeys?: readonly string[];
}

export const EVAL_DOCUMENTS: readonly EvalDocument[] = [
  {
    name: '体检报告.txt',
    text: '血脂检查\n\n低密度脂蛋白 LDL 为 3.8 mmol/L，建议三个月后复查。\n\n肝功能正常。',
  },
  {
    name: '项目合同.txt',
    text: '付款条款\n\n甲方应在验收后三十天内付款。逾期需提前书面通知，并协商新的付款日期。',
  },
  {
    name: '旅行计划.txt',
    text: '杭州三天行程\n\n第一天西湖，第二天灵隐寺，第三天西溪湿地。住宿在西湖附近。',
  },
  {
    name: '代码规范.txt',
    text: '数据库变更规范\n\n任何 schema 变更必须先写迁移脚本，经过审查后才能上线。不要直接改生产库。',
  },
  {
    name: '产品手册.txt',
    text: '保修政策\n\n主机保修两年，电池保修一年。人为损坏不在保修范围内，维修前需出示购买凭证。',
  },
  {
    name: '会议纪要.txt',
    text: '项目例会纪要\n\n项目预算上限二十万元，负责人是李工，下次评审定在十一月三号。',
  },
  {
    name: '采购清单.txt',
    text: '办公用品采购\n\n打印机两台，黑色墨盒四个，A4 纸十箱。供应商报价含税。',
  },
  {
    name: '学习计划.txt',
    text: '雅思备考计划\n\n每天学习两小时，先练听力和阅读，周末做一套完整模考。目标七分。',
  },
];

export const EVAL_DOCUMENT_CASES: readonly EvalDocumentCase[] = [
  { q: 'LDL 多少', want: ['3.8'] },
  { q: '多久复查', want: ['三个月后复查'] },
  { q: '付款期限', want: ['三十天'] },
  { q: '逾期怎么处理', want: ['书面通知'] },
  { q: '杭州第一天去哪', want: ['西湖'] },
  { q: '住宿在哪', want: ['西湖附近'] },
  { q: '数据库能直接改吗', want: ['不要直接改生产库'], answerKeys: ['不能直接改'] },
  { q: 'schema 变更流程', want: ['迁移脚本'] },
  { q: '肝功能正常吗', want: ['肝功能正常'], answerKeys: ['正常'] },
  { q: '灵隐寺第几天', want: ['第二天'] },
  { q: '电池保修多久', want: ['电池保修一年'] },
  { q: '主机保修几年', want: ['两年'] },
  { q: '保修要什么凭证', want: ['购买凭证'] },
  { q: '项目预算多少', want: ['二十万元'] },
  { q: '项目负责人是谁', want: ['李工'] },
  { q: '下次评审什么时候', want: ['十一月三号'] },
  { q: '打印机买几台', want: ['两台'] },
  { q: '墨盒要几个', want: ['四个'] },
  { q: 'A4 纸买多少', want: ['十箱'] },
  { q: '雅思每天学多久', want: ['两小时'] },
  { q: '雅思先练什么', want: ['听力'] },
  { q: '雅思目标分数', want: ['七分'] },
  { q: '验收后多久付款', want: ['三十天'] },
  { q: '合同逾期需要通知吗', want: ['书面通知'] },
  { q: '电池坏了保修吗', want: ['电池保修一年'] },
  { q: '项目预算和负责人', want: ['二十万元', '李工'] },
  { q: '采购清单包含什么', want: ['打印机'] },
  { q: '杭州行程第三天', want: ['西溪湿地'] },
  { q: '学习计划周末做什么', want: ['模考'] },
  { q: '血脂检查结果', want: ['3.8'] },
];
