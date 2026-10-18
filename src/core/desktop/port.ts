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
  /** 关掉子进程（进程退出/测试清理时调）*/
  close(): void;
}

/** 该平台是否可能支持桌面控制（Windows 之外不注册工具）*/
export function isDesktopPlatform(): boolean {
  return process.platform === 'win32';
}
