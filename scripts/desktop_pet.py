#!/usr/bin/env python3
"""butler 桌宠 —— 不打开网页也能用的一小块桌面。

═══ 它是什么 ═══

一个常驻的透明窗口：人物站在桌面上，左键点开下方的"桌板"，
里面有输入框（文件 / 语音 / 发送）、正在执行的阶段、以及流式到达的正文。

═══ 它刻意不是什么 ═══

  · 不是网页版的缩小复制品：桌板只放"说给用户听的话"，
    思考、工具名、工具参数、工具结果一律不上屏（在 chat.py 就丢掉了）；
  · 不复制业务逻辑：会话、记忆、工具、审批都还在 Next 那一侧，
    这里只是 `/api/chat` 的一个客户端；
  · 不假装能做的事：语音不可用、主应用没起、附件读失败，都当场说清楚。

═══ 启动方式 ═══

  pythonw scripts/desktop_pet.py          # 正常启动（或双击 启动桌宠.bat）
  python  scripts/desktop_pet.py --demo   # 演示模式：不需要主应用，自动跑一轮
  BUTLER_URL=http://127.0.0.1:3000        # 指向别的端口

⚠️ DPI 必须在创建 Tk **之前**声明。晚一步，Windows 会把窗口按 125% 虚拟化，
   桌板算出来的底边和截图像素对不上，输入框会掉到屏幕外。
"""

from __future__ import annotations

import atexit
import ctypes
import sys
import traceback
from datetime import datetime

# pythonw 没有控制台，sys.stderr 可能是 None；所有打印都要能容忍这一点
def _stderr(text: str) -> None:
    try:
        if sys.stderr is not None:
            sys.stderr.write(text + '\n')
            sys.stderr.flush()
    except Exception:
        pass


def _set_dpi_aware() -> None:
    if sys.platform != 'win32':
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE_V2
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _write_crash(text: str) -> str | None:
    try:
        from petapp.store import Paths

        paths = Paths()
        paths.data_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(paths.error_log, 'a', encoding='utf-8') as handle:
            handle.write(f'\n===== {stamp} =====\n{text}\n')
        return str(paths.error_log)
    except Exception:
        return None


def main() -> None:
    demo = '--demo' in sys.argv or '--preview' in sys.argv
    snap_dir = None
    if '--snap' in sys.argv:
        index = sys.argv.index('--snap')
        if index + 1 < len(sys.argv):
            snap_dir = sys.argv[index + 1]
    _set_dpi_aware()

    # 包目录在 scripts/ 下；直接跑脚本时 sys.path[0] 已经是 scripts/
    sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))

    from petapp.store import Paths, acquire_instance_lock, release_instance_lock

    paths = Paths()
    lock = acquire_instance_lock(paths)
    if lock is None:
        _stderr('butler 桌宠已经在运行')
        raise SystemExit(0)
    atexit.register(release_instance_lock, paths, lock)

    try:
        import tkinter as tk
    except Exception as err:
        _stderr(f'无法加载 Tkinter：{err}')
        raise SystemExit(2)

    try:
        root = tk.Tk()
    except Exception as err:
        _stderr(f'无法创建 Tk 窗口：{err}')
        release_instance_lock(paths, lock)
        raise SystemExit(2)

    def report_callback_exception(exc_type, exc_value, exc_tb) -> None:  # type: ignore[no-untyped-def]
        text = ''.join(traceback.format_exception(exc_type, exc_value, exc_tb))
        _write_crash(text)
        _stderr(text)

    root.report_callback_exception = report_callback_exception

    try:
        from petapp.app import PetApp

        app = PetApp(root, demo=demo, snap_dir=snap_dir)
    except Exception:
        text = traceback.format_exc()
        log = _write_crash(text)
        _stderr(text)
        try:
            from tkinter import messagebox

            messagebox.showerror(
                'butler 桌宠',
                '桌宠没能启动。\n\n' + text[-800:] + (f'\n\n日志：{log}' if log else ''),
            )
        except Exception:
            pass
        release_instance_lock(paths, lock)
        raise SystemExit(1)

    atexit.register(app.quit)
    try:
        root.mainloop()
    finally:
        release_instance_lock(paths, lock)


if __name__ == '__main__':
    main()
