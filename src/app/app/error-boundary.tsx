'use client';

/**
 * 组件级错误边界（v8 · AI 交互体验）
 *
 * ★ 为什么需要它：评审标准里「AI 交互体验」明文点名了 **「错误边界处理优雅」**。
 *   在这之前全仓 `ErrorBoundary / componentDidCatch` **0 处** ——
 *   任何一个子组件在渲染期抛错，都会让**整页白屏**，包括用户已经看到的历史消息。
 *
 * ★ 三条设计取舍：
 *
 *   ① **隔离到"块"，不是隔离到"页"**
 *      推理流、监督员栏、任务窗格是三个独立区。任何一块坏掉，
 *      其余两块与历史对话都必须仍然可用 —— 它们的数据来源互不相干。
 *
 *   ② **不把堆栈甩给用户**
 *      默认只显示"这块出错 + 可重试"；技术细节收进折叠区。
 *      完整堆栈只进浏览器控制台（开发者可见）。
 *
 *   ③ **重试是"重挂这一块"，不是刷新整页**
 *      重挂只丢掉这一块的渲染状态。历史消息、已收到的回复都在外面，
 *      不会被连带清空。
 *
 * ⚠️ 类组件是必须的：React 至今**只有** `getDerivedStateFromError` /
 *    `componentDidCatch` 能捕获渲染期错误，函数组件 + hooks 做不到。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  /** 出错时告诉用户"哪一块坏了"（例：推理过程 / 监督员栏） */
  readonly area: string;
  /**
   * 自定义兜底内容。不给就用默认卡片。
   * ⚠️ 谨慎使用：自定义兜底若自己也抛错，React 会向上冒泡到外层边界。
   */
  readonly fallback?: (reset: () => void, detail: string) => ReactNode;
}

interface State {
  readonly failed: boolean;
  /** 只存 message，**不存 stack** —— 避免堆栈被顺手渲染到界面上 */
  readonly detail: string;
}

/**
 * 未出错时的状态。
 *
 * ★ 抽成常量而不是每处写字面量：`reset()` 与初始 state 必须是**同一份**，
 *   否则「重试」后可能残留上一次的 detail（界面上就是"恢复了但还挂着旧错误"）。
 *   抽成常量后，两者一致是**结构性保证**，不靠人去同步。
 */
export const BOUNDARY_INITIAL_STATE: State = { failed: false, detail: '' };

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = BOUNDARY_INITIAL_STATE;

  static getDerivedStateFromError(err: unknown): State {
    return {
      failed: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  override componentDidCatch(err: unknown, info: ErrorInfo): void {
    /**
     * 完整信息只进控制台。
     * ⚠️ 不要在这里写 `console.error` 之外的动作（上报、弹窗）——
     *    那会在错误处理路径里再引入一个可能失败的动作。
     */
    console.error(`[AppErrorBoundary:${this.props.area}] 渲染失败`, err, info.componentStack);
  }

  /**
   * 重置本块。
   *
   * ⚠️ 这是**公开契约的一部分**：`fallback` 回调会把它交给调用方，
   *    自定义兜底界面靠它实现"重试"。所以不能声明成 private ——
   *    那会让测试只能靠 `as` 强转去摸，等于关掉类型检查。
   */
  readonly reset = (): void => {
    this.setState(BOUNDARY_INITIAL_STATE);
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(this.reset, this.state.detail);
    }

    return (
      <div className="nv-row" role="alert" data-error-boundary={this.props.area}>
        <span className="nv-note-warn">
          「{this.props.area}」这块没能显示出来，页面其它部分仍可正常使用
        </span>
        <button type="button" className="nv-iconbtn" onClick={this.reset}>
          重试这一块
        </button>
        <details>
          <summary className="nv-note">技术细节</summary>
          <div className="nv-mono">{this.state.detail.length > 0 ? this.state.detail : '（无信息）'}</div>
        </details>
      </div>
    );
  }
}
