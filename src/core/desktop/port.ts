/**
 * 桌面控制的能力端口（core 层只认这个接口）
 *
 * ★ 为什么在 core 里定义接口、在 adapters 里实现：
 *   子进程、COM、UIA 全是 IO 与平台相关的脏活。
 *   核心层（工具规格、权限分级、审计）只依赖这个窄接口，
 *   于是**单元测试可以用一个假实现**跑完所有工具逻辑，不需要 Python。
 */

/** 本机能力探测结果（`ping` 的返回）*/
export interface DesktopCapabilities {
  readonly python: string;
  readonly platform: string;
  /** 模块名 → 是否可用（win32com / uiautomation / mss / pyautogui / PIL）*/
  readonly capabilities: Readonly<Record<string, boolean>>;
}

/** 一个顶层窗口 */
export interface DesktopWindow {
  readonly title: string;
  readonly className: string;
  readonly processId: number;
}

/** Office 转换结果 */
export interface ConvertResult {
  readonly source: string;
  readonly target: string;
  readonly bytes: number;
}

/** 截图结果 */
export interface ShotResult {
  readonly path: string;
  readonly backend: string;
  readonly width: number;
  readonly height: number;
}

/** UIA 控件描述 */
export interface UiaControl {
  readonly type: string;
  readonly name: string;
  readonly automationId: string;
  readonly rect: readonly [number, number, number, number];
  /** 该控件真正支持的模式（Invoke / Toggle / SelectionItem / ExpandCollapse / Value）*/
  readonly patterns?: readonly string[];
}

/** 控件树里的一个节点 */
export interface UiaNode extends UiaControl {
  readonly depth: number;
  readonly className: string;
}

/** 找控件的返回值：**报告全部匹配**，由调用方决定是否动手 */
export interface UiaFindResult {
  readonly count: number;
  readonly matches: readonly UiaControl[];
}

/** 控件树（**必须能表达"被截断了"**）*/
export interface UiaTreeResult {
  readonly nodes: readonly UiaNode[];
  /**
   * 是否可能被上限截断。
   *
   * ⚠️ 隐瞒截断是有害的：模型看到 200 个控件会以为"界面就这些"，
   *    于是得出"没有这个按钮"的错误结论。宁可多给一个字段。
   */
  readonly truncated: boolean;
  readonly limits: { readonly depth: number; readonly max: number };
}

/** UIA 操作的结果（**必须带校验**）*/
export interface UiaActionResult {
  readonly action: string;
  readonly control: UiaControl;
  /** 操作前的状态（toggle: 0/1/2；select: boolean）；无可读状态时为 null */
  readonly before: number | boolean | null;
  readonly after: number | boolean | null;
  /** 状态确实变了才为 true；无状态可比对时为 null */
  readonly verified: boolean | null;
}

/** 设置输入框内容的结果 */
export interface UiaSetValueResult {
  readonly control: UiaControl;
  readonly before: string;
  readonly after: string;
  readonly verified: boolean;
}

/**
 * 桌面桥。
 *
 * ⚠️ 所有方法都可能抛错（进程崩了 / Python 缺模块 / 文件不存在）。
 *    **不要让工具把它吞掉** —— 工具要把失败原因如实返回给模型，
 *    否则模型会以为"做成了"。
 */
export interface DesktopBridgePort {
  /** 探测本机能力；**只在启动时调一次** */
  ping(): Promise<DesktopCapabilities>;
  listWindows(limit?: number): Promise<readonly DesktopWindow[]>;
  officeConvert(source: string, target: string): Promise<ConvertResult>;
  screenshot(): Promise<ShotResult>;

  // ── UIA：按**元素**操作（不按坐标）──
  //
  // ★ 为什么这层重要（实测证据）：
  //   操作 Windows 设置时全程零坐标点击，窗口被挡住也照样生效；
  //   而酷狗那种自绘 UI 只能靠坐标，且会被叠加窗口吞掉点击。

  /** 导出窗口控件树 */
  uiaTree(window: string, depth?: number, max?: number): Promise<UiaTreeResult>;
  /** 按名字找控件（**只报告，不动手**）*/
  uiaFind(window: string, name: string, controlType?: string): Promise<UiaFindResult>;
  /** 按模式操作控件，并读回状态校验 */
  uiaAction(
    window: string,
    name: string,
    action: 'toggle' | 'select' | 'invoke' | 'expand' | 'collapse',
    controlType?: string,
  ): Promise<UiaActionResult>;
  /** 给标准输入框设值（自绘 UI 会如实失败）*/
  uiaSetValue(window: string, name: string, value: string): Promise<UiaSetValueResult>;

  /** 关掉子进程（进程退出/测试清理时调）*/
  close(): void;
}

/** 该平台是否可能支持桌面控制（Windows 之外不注册工具）*/
export function isDesktopPlatform(): boolean {
  return process.platform === 'win32';
}
