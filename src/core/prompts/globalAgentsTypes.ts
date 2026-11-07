/**
 * 全局 AGENTS 快照形状（core 与 app 共用）。
 *
 * ★ 单独一个类型文件，避免 `prompts/globalAgents.ts` 与
 *   `chat/settings.ts` 之间出现循环依赖。
 */
export interface GlobalAgentsSnapshot {
  /** 已读取到的规则正文（文件缺失/损坏时为 ''） */
  readonly text: string;
  /** 文件内容哈希（缺失/损坏时为空字符串） */
  readonly hash: string;
  /** 文件内容长度（字符数；缺失/损坏时为 0） */
  readonly length: number;
  /** 文件是否存在且可读 */
  readonly loaded: boolean;
  /** 是否因为过长被截断（截断仍可用，不算损坏） */
  readonly truncated: boolean;
  /** 缺失/损坏原因（只给日志与事件，不注入提示词） */
  readonly error?: string;
}
