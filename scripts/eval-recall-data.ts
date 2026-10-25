/**
 * 记忆召回评测数据集（dev / test 分离）
 *
 * 纪律：
 *   · 查询只描述“用户会怎么说”，不写实现规则；
 *   · expected 是应该被想起的记忆 id，不是关键词；
 *   · dev 用来调参数，test 只在最后跑一次；
 *   · 负例只允许硬约束被召回，其它任何软记忆都算误召回；
 *   · 不按领域写特殊逻辑，领域只用于造数据。
 */

export type RecallSplit = 'dev' | 'test';

export type RecallCategory =
  | 'literal'
  | 'paraphrase'
  | 'cross-domain'
  | 'constraint'
  | 'temporal'
  | 'negative';

export interface RecallSeed {
  readonly id: string;
  readonly memClass: 'global_constraint' | 'global_shared' | 'sensitive' | 'domain';
  readonly kind: 'fact' | 'preference' | 'principle' | 'summary';
  readonly content: string;
  readonly domain?: 'life' | 'health' | 'study' | 'work' | 'code';
}

export interface RecallCase {
  /** 数据集内稳定 id，便于复盘，不参与召回。 */
  readonly id: string;
  readonly split: RecallSplit;
  readonly category: RecallCategory;
  readonly text: string;
  /** 至少命中一条即算 hit；按顺序取第一个命中的 rank。 */
  readonly expected: readonly string[];
}

export const RECALL_SEEDS: readonly RecallSeed[] = [
  {
    id: 'm_allergy',
    memClass: 'global_constraint',
    kind: 'fact',
    content: '用户对花生严重过敏，饮食必须完全避开花生及花生制品。',
  },
  {
    id: 'm_medication',
    memClass: 'global_constraint',
    kind: 'fact',
    content: '用户正在服用华法林，需要控制维生素K摄入。',
  },
  {
    id: 'm_fat',
    memClass: 'domain',
    kind: 'preference',
    content: '用户正在减脂期，需要控制油脂和热量摄入。',
    domain: 'health',
  },
  {
    id: 'm_cilantro',
    memClass: 'domain',
    kind: 'preference',
    content: '用户不吃香菜。',
    domain: 'life',
  },
  {
    id: 'm_quiet',
    memClass: 'domain',
    kind: 'preference',
    content: '用户喜欢安静的用餐环境。',
    domain: 'life',
  },
  {
    id: 'm_hz',
    memClass: 'domain',
    kind: 'fact',
    content: '用户住在杭州，工作在滨江。',
    domain: 'life',
  },
  {
    id: 'm_commute',
    memClass: 'domain',
    kind: 'fact',
    content: '用户平时坐地铁通勤，单程大约四十分钟。',
    domain: 'life',
  },
  {
    id: 'm_daughter',
    memClass: 'domain',
    kind: 'fact',
    content: '用户的女儿叫小雨，今年八岁，喜欢画画。',
    domain: 'life',
  },
  {
    id: 'm_birthday',
    memClass: 'domain',
    kind: 'fact',
    content: '用户母亲的生日是十月十二号。',
    domain: 'life',
  },
  {
    id: 'm_deadline',
    memClass: 'domain',
    kind: 'fact',
    content: '项目A必须在周五前交付。',
    domain: 'work',
  },
  {
    id: 'm_accept',
    memClass: 'domain',
    kind: 'fact',
    content: '项目A的验收材料包括设计稿和部署文档。',
    domain: 'work',
  },
  {
    id: 'm_budget',
    memClass: 'domain',
    kind: 'fact',
    content: '项目A的预算上限是二十万元。',
    domain: 'work',
  },
  {
    id: 'm_meeting',
    memClass: 'domain',
    kind: 'fact',
    content: '项目例会安排在周一上午十点。',
    domain: 'work',
  },
  {
    id: 'm_schema',
    memClass: 'domain',
    kind: 'fact',
    content: '数据库 schema 变更必须先写迁移脚本，不能直接改生产库。',
    domain: 'code',
  },
  {
    id: 'm_pnpm',
    memClass: 'domain',
    kind: 'preference',
    content: '项目使用 pnpm 管理依赖。',
    domain: 'code',
  },
  {
    id: 'm_check',
    memClass: 'domain',
    kind: 'fact',
    content: '提交代码前必须运行 typecheck 和测试。',
    domain: 'code',
  },
  {
    id: 'm_sleep',
    memClass: 'domain',
    kind: 'fact',
    content: '用户每天晚上十一点睡觉，早上七点起床。',
    domain: 'health',
  },
  {
    id: 'm_penicillin',
    memClass: 'domain',
    kind: 'fact',
    content: '用户对青霉素过敏。',
    domain: 'health',
  },
  {
    id: 'm_swim',
    memClass: 'domain',
    kind: 'fact',
    content: '用户每周三晚上有游泳课。',
    domain: 'health',
  },
  {
    id: 'm_tea',
    memClass: 'domain',
    kind: 'preference',
    content: '用户喜欢喝无糖乌龙茶。',
    domain: 'life',
  },
  {
    id: 'm_coffee',
    memClass: 'domain',
    kind: 'preference',
    content: '用户每天早上喝一杯黑咖啡，不加糖。',
    domain: 'life',
  },
  {
    id: 'm_books',
    memClass: 'domain',
    kind: 'preference',
    content: '用户周末通常去图书馆看书。',
    domain: 'study',
  },
  {
    id: 'm_english',
    memClass: 'domain',
    kind: 'fact',
    content: '用户正在准备雅思考试，目标七分。',
    domain: 'study',
  },
  {
    id: 'm_guitar',
    memClass: 'domain',
    kind: 'preference',
    content: '用户计划明年学吉他，从基础和弦开始。',
    domain: 'study',
  },
  {
    id: 'm_travel',
    memClass: 'domain',
    kind: 'preference',
    content: '用户喜欢去日本旅行，偏好安静的小城市。',
    domain: 'life',
  },
  {
    id: 'm_cat',
    memClass: 'domain',
    kind: 'fact',
    content: '用户对猫毛过敏，家里不能养猫。',
    domain: 'health',
  },
];

const dev = (id: string, category: RecallCategory, text: string, expected: readonly string[]): RecallCase => ({
  id,
  split: 'dev',
  category,
  text,
  expected,
});

const test = (id: string, category: RecallCategory, text: string, expected: readonly string[]): RecallCase => ({
  id,
  split: 'test',
  category,
  text,
  expected,
});

export const RECALL_POSITIVES: readonly RecallCase[] = [
  // ── dev：40 条 ──
  dev('p01', 'paraphrase', '我想吃火锅，推荐一家', ['m_fat']),
  dev('p02', 'constraint', '点外卖要注意什么', ['m_allergy']),
  dev('p03', 'literal', '我不吃香菜', ['m_cilantro']),
  dev('p04', 'paraphrase', '找一家安静点的餐厅', ['m_quiet']),
  dev('p05', 'literal', '我住哪来着', ['m_hz']),
  dev('p06', 'literal', '我女儿几岁了', ['m_daughter']),
  dev('p07', 'literal', '项目A什么时候交', ['m_deadline']),
  dev('p08', 'literal', '项目A验收要交哪些材料', ['m_accept']),
  dev('p09', 'literal', '数据库能直接改吗', ['m_schema']),
  dev('p10', 'literal', '这个项目用什么包管理器', ['m_pnpm']),
  dev('p11', 'literal', '我一般几点睡觉', ['m_sleep']),
  dev('p12', 'literal', '我对什么药过敏', ['m_penicillin']),
  dev('p13', 'literal', '我喜欢喝什么茶', ['m_tea']),
  dev('p14', 'literal', '周几开例会', ['m_meeting']),
  dev('p15', 'literal', '提交代码前要做什么', ['m_check']),
  dev('p16', 'cross-domain', '花生和香菜都要避开', ['m_allergy', 'm_cilantro']),
  dev('p17', 'literal', '我工作地点在哪', ['m_hz']),
  dev('p18', 'paraphrase', '孩子多大了', ['m_daughter']),
  dev('p19', 'paraphrase', '生产库能直接改吗', ['m_schema']),
  dev('p20', 'paraphrase', '周五前要完成什么', ['m_deadline']),
  dev('p21', 'literal', '我平时怎么通勤', ['m_commute']),
  dev('p22', 'literal', '项目A要交设计稿吗', ['m_accept']),
  dev('p23', 'literal', '我睡觉时间是几点', ['m_sleep']),
  dev('p24', 'constraint', '青霉素过敏能用吗', ['m_penicillin']),
  dev('p25', 'paraphrase', '找家茶饮店', ['m_tea']),
  dev('p26', 'paraphrase', '例会时间是周几', ['m_meeting']),
  dev('p27', 'paraphrase', '代码写完了要跑什么', ['m_check']),
  dev('p28', 'literal', '减脂期间吃什么', ['m_fat']),
  dev('p29', 'literal', '我住在哪个城市', ['m_hz']),
  dev('p30', 'paraphrase', '孩子叫什么名字', ['m_daughter']),
  dev('p31', 'paraphrase', '今晚想涮锅，有什么建议', ['m_fat']),
  dev('p32', 'paraphrase', '最近在控制体重，外面吃啥好', ['m_fat']),
  dev('p33', 'paraphrase', '想找家不吵的馆子', ['m_quiet']),
  dev('p34', 'paraphrase', '我闺女几岁了', ['m_daughter']),
  dev('p35', 'paraphrase', '上班通勤远不远', ['m_commute']),
  dev('p36', 'paraphrase', '交付截止到哪天', ['m_deadline']),
  dev('p37', 'paraphrase', '验收需要准备哪些文档', ['m_accept']),
  dev('p38', 'paraphrase', '改数据库表要先做什么', ['m_schema']),
  dev('p39', 'paraphrase', '装依赖用 npm 还是 pnpm', ['m_pnpm']),
  dev('p40', 'paraphrase', '提交前检查清单', ['m_check']),

  // ── test：20 条（只在最后跑一次）──
  test('p41', 'paraphrase', '我每天几点起床', ['m_sleep']),
  test('p42', 'paraphrase', '喝茶有什么偏好', ['m_tea']),
  test('p43', 'paraphrase', '咖啡怎么喝', ['m_coffee']),
  test('p44', 'paraphrase', '周三晚上有什么安排', ['m_swim']),
  test('p45', 'constraint', '对猫毛过敏吗', ['m_cat']),
  test('p46', 'paraphrase', '我妈生日是哪天', ['m_birthday']),
  test('p47', 'paraphrase', '项目预算多少', ['m_budget']),
  test('p48', 'paraphrase', '我在准备什么考试', ['m_english']),
  test('p49', 'paraphrase', '想学什么乐器', ['m_guitar']),
  test('p50', 'paraphrase', '假期想去哪玩', ['m_travel']),
  test('p51', 'constraint', '对什么食物过敏', ['m_allergy']),
  test('p52', 'cross-domain', '外面吃饭要注意什么', ['m_allergy', 'm_fat']),
  test('p53', 'cross-domain', '周末想找个安静地方看书', ['m_books', 'm_quiet']),
  test('p54', 'paraphrase', '周末带孩子去哪', ['m_daughter']),
  test('p55', 'paraphrase', '平时看什么书', ['m_books']),
  test('p56', 'constraint', '吃什么药要注意', ['m_medication']),
  test('p57', 'literal', '维K和华法林', ['m_medication']),
  test('p58', 'literal', '项目例会在几点', ['m_meeting']),
  test('p59', 'paraphrase', '代码检查要跑什么', ['m_check']),
  test('p60', 'paraphrase', '住在杭州哪里', ['m_hz']),
];

export const RECALL_NEGATIVES: readonly RecallCase[] = [
  { id: 'n01', split: 'dev', category: 'negative', text: '今天天气怎么样', expected: [] },
  { id: 'n02', split: 'dev', category: 'negative', text: '帮我写一首诗', expected: [] },
  { id: 'n03', split: 'dev', category: 'negative', text: '推荐一部电影', expected: [] },
  { id: 'n04', split: 'dev', category: 'negative', text: '我的猫叫什么', expected: [] },
  { id: 'n05', split: 'dev', category: 'negative', text: '合同付款方式', expected: [] },
  { id: 'n06', split: 'dev', category: 'negative', text: '今天股票行情怎么样', expected: [] },
  { id: 'n07', split: 'dev', category: 'negative', text: '怎么修打印机', expected: [] },
  { id: 'n08', split: 'dev', category: 'negative', text: '明天会下雨吗', expected: [] },
  { id: 'n09', split: 'dev', category: 'negative', text: '推荐一款手机', expected: [] },
  { id: 'n10', split: 'dev', category: 'negative', text: '给我讲个笑话', expected: [] },
  { id: 'n11', split: 'test', category: 'negative', text: '电脑蓝屏怎么办', expected: [] },
  { id: 'n12', split: 'test', category: 'negative', text: '附近有什么加油站', expected: [] },
  { id: 'n13', split: 'test', category: 'negative', text: '帮我翻译这段英文', expected: [] },
  { id: 'n14', split: 'test', category: 'negative', text: '一加一等于几', expected: [] },
  { id: 'n15', split: 'test', category: 'negative', text: '推荐一首歌', expected: [] },
  { id: 'n16', split: 'test', category: 'negative', text: '今天星期几', expected: [] },
  { id: 'n17', split: 'test', category: 'negative', text: '怎么设置路由器', expected: [] },
  { id: 'n18', split: 'test', category: 'negative', text: '我的车停在哪', expected: [] },
  { id: 'n19', split: 'test', category: 'negative', text: '北京有什么好玩', expected: [] },
  { id: 'n20', split: 'test', category: 'negative', text: '怎么申请护照', expected: [] },
];
