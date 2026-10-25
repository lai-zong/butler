/**
 * 事实抽取评测数据（50 条：40 条应提取 + 10 条不应提取）
 *
 * 纪律：
 *   · expected 是“必须命中的关键事实片段”，不是全文摘要；
 *   · 临时计划（下个月出差、明年旅行）按产品规则**不应**提取，
 *     列为负例，而不是硬塞进“应该提取”；
 *   · 负例要求 `facts` 为空；模型硬凑事实就是误提取。
 */

export interface ExtractionEvalCase {
  readonly id: string;
  readonly text: string;
  /** 必须命中的关键片段；空数组表示“不应提取任何事实”。 */
  readonly expected: readonly string[];
  readonly category: 'identity' | 'constraint' | 'preference' | 'context' | 'negative';
}

export const EXTRACTION_CASES: readonly ExtractionEvalCase[] = [
  { id: 'e01', text: '我对花生严重过敏，出去吃饭一定不能碰花生油。', expected: ['花生'], category: 'constraint' },
  { id: 'e02', text: '我每天早上七点半要喝一杯黑咖啡，不加糖。', expected: ['咖啡'], category: 'preference' },
  { id: 'e03', text: '我女儿叫小雨，今年八岁，喜欢画画。', expected: ['小雨', '八岁'], category: 'identity' },
  { id: 'e04', text: '我住在杭州，工作在滨江，通勤一般坐地铁。', expected: ['杭州'], category: 'identity' },
  { id: 'e05', text: '每周三晚上我要去上游泳课，别在那个时间安排别的。', expected: ['游泳'], category: 'context' },
  { id: 'e06', text: '我对猫毛过敏，家里不能养猫。', expected: ['猫毛'], category: 'constraint' },
  { id: 'e07', text: '我妈妈生日是十月十二号，记得提前提醒我。', expected: ['十月十二'], category: 'identity' },
  { id: 'e08', text: '我不吃香菜，点外卖备注不要香菜。', expected: ['香菜'], category: 'preference' },
  { id: 'e09', text: '我每天晚上十一点睡觉，早上七点起床。', expected: ['十一点', '七点'], category: 'context' },
  { id: 'e10', text: '我对青霉素过敏。', expected: ['青霉素'], category: 'constraint' },
  { id: 'e11', text: '我的车是白色的，停在小区地下车库。', expected: ['白色'], category: 'identity' },
  { id: 'e12', text: '周末通常去图书馆看书。', expected: ['图书馆'], category: 'preference' },
  { id: 'e13', text: '我喜欢喝无糖乌龙茶。', expected: ['乌龙'], category: 'preference' },
  { id: 'e14', text: '我对鸡蛋过敏，吃蛋糕和面包时要特别注意。', expected: ['鸡蛋'], category: 'constraint' },
  { id: 'e15', text: '我每周二晚上打羽毛球。', expected: ['羽毛球'], category: 'context' },
  { id: 'e16', text: '我老婆叫小雅，她喜欢百合花。', expected: ['小雅'], category: 'identity' },
  { id: 'e17', text: '我通常九点下班。', expected: ['九点'], category: 'context' },
  { id: 'e18', text: '我不喝酒，聚餐时请给我准备无酒精饮料。', expected: ['酒'], category: 'preference' },
  { id: 'e19', text: '我喜欢听古典音乐。', expected: ['古典'], category: 'preference' },
  { id: 'e20', text: '我明年想学吉他，最好从基础和弦开始。', expected: ['吉他'], category: 'context' },
  { id: 'e21', text: '我的快递一般放在门口鞋柜旁边。', expected: ['快递'], category: 'context' },
  { id: 'e22', text: '我住在上海浦东。', expected: ['上海'], category: 'identity' },
  { id: 'e23', text: '我每天喝两升水。', expected: ['两升'], category: 'context' },
  { id: 'e24', text: '我每天晚饭后散步半小时。', expected: ['散步'], category: 'context' },
  { id: 'e25', text: '我儿子在上小学，放学后由奶奶接。', expected: ['小学'], category: 'identity' },
  { id: 'e26', text: '我对花粉过敏，春天出门要戴口罩。', expected: ['花粉'], category: 'constraint' },
  { id: 'e27', text: '我每周日给父母打电话。', expected: ['父母'], category: 'context' },
  { id: 'e28', text: '我习惯用左手写字。', expected: ['左手'], category: 'identity' },
  { id: 'e29', text: '我养的狗叫豆豆。', expected: ['豆豆'], category: 'identity' },
  { id: 'e30', text: '我最近在准备雅思考试。', expected: ['雅思'], category: 'context' },
  { id: 'e31', text: '我对芒果过敏。', expected: ['芒果'], category: 'constraint' },
  { id: 'e32', text: '我每天早上跑步半小时。', expected: ['跑步'], category: 'context' },
  { id: 'e33', text: '我每周六上午去上钢琴课。', expected: ['钢琴'], category: 'context' },
  { id: 'e34', text: '我对尘螨过敏，家里要经常除螨。', expected: ['尘螨'], category: 'constraint' },
  { id: 'e35', text: '我明年想考注册会计师。', expected: ['注册会计师'], category: 'context' },
  { id: 'e36', text: '我平时用 Mac 办公。', expected: ['Mac'], category: 'preference' },
  { id: 'e37', text: '我妈妈有糖尿病，饮食要少糖。', expected: ['糖尿病'], category: 'constraint' },
  { id: 'e38', text: '我喜欢喝无糖豆浆。', expected: ['豆浆'], category: 'preference' },
  { id: 'e39', text: '我每天晚上冥想十分钟。', expected: ['冥想'], category: 'context' },
  { id: 'e40', text: '我不吃牛肉。', expected: ['牛肉'], category: 'preference' },

  // ── 负例：不含“关于用户本人且长期有效”的事实 ──
  { id: 'n01', text: '我下个月要去成都出差三天，帮我留意天气和行程。', expected: [], category: 'negative' },
  { id: 'n02', text: '我明年想去日本旅行。', expected: [], category: 'negative' },
  { id: 'n03', text: '今天有点累。', expected: [], category: 'negative' },
  { id: 'n04', text: '帮我查一下明天天气。', expected: [], category: 'negative' },
  { id: 'n05', text: '推荐几家附近的餐厅。', expected: [], category: 'negative' },
  { id: 'n06', text: '今天股票行情怎么样？', expected: [], category: 'negative' },
  { id: 'n07', text: '帮我写一首诗。', expected: [], category: 'negative' },
  { id: 'n08', text: '一加一等于几？', expected: [], category: 'negative' },
  { id: 'n09', text: '明天会下雨吗？', expected: [], category: 'negative' },
  { id: 'n10', text: '周末想去看电影。', expected: [], category: 'negative' },
];
