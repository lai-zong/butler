#!/usr/bin/env python3
"""桌宠界面预览 —— 不连主应用，跑一遍演示时序并把几个状态截成图。

★ 为什么需要它：
  桌板的排版改一行就可能挤掉一行字，而"打开主应用、等模型回答"这条路
  要几十秒还依赖网络。这个脚本用**演示数据**把五个状态走一遍，
  直接产出 docs/ui-preview 里的预览图，也算一次最小自检。

用法：
    python scripts/pet_preview.py
    python scripts/pet_preview.py --out some/dir

⚠️ 截图前请先退出正在运行的桌宠：它是置顶窗口，会压在这块背板上面。
"""

from __future__ import annotations

import ctypes
import os
import shutil
import sys
import tempfile
import tkinter as tk
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 演示截图与文档里的文件名对应关系
RENAME = {
    '01-idle': 'pet-idle',
    '02-running-expanded': 'pet-running',
    '04-done': 'pet-done',
}


def _running_pet() -> int | None:
    pid_file = ROOT / '.butler-data' / 'pet.pid'
    try:
        pid = int(pid_file.read_text(encoding='utf-8').strip())
    except Exception:
        return None
    try:
        os.kill(pid, 0)
        return pid
    except Exception:
        return None


def main() -> None:
    out_dir = ROOT / 'docs' / 'ui-preview'
    if '--out' in sys.argv:
        index = sys.argv.index('--out')
        if index + 1 < len(sys.argv):
            out_dir = Path(sys.argv[index + 1]).resolve()

    running = _running_pet()
    if running is not None:
        print(f'桌宠正在运行（pid {running}），先退出再截图，否则会挡住背板。')
        raise SystemExit(2)

    if sys.platform == 'win32':
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass

    shots_dir = Path(tempfile.mkdtemp(prefix='butler-pet-preview-'))
    # 演示模式本来就不联网；把地址指到一个死端口，避免误连本机正在跑的主应用
    os.environ['BUTLER_URL'] = 'http://127.0.0.1:3999'
    os.environ['BUTLER_DATA_DIR'] = str(shots_dir / 'data')
    sys.path.insert(0, str(ROOT / 'scripts'))

    from petapp.app import PetApp  # 延迟导入：DPI 与 sys.path 都就绪了

    root = tk.Tk()
    app = PetApp(root, demo=True, snap_dir=str(shots_dir))

    # 一块干净的背板：预览图里不该出现用户桌面
    backdrop = tk.Toplevel(root)
    backdrop.overrideredirect(True)
    backdrop.geometry(f'{root.winfo_screenwidth()}x{root.winfo_screenheight()}+0+0')
    backdrop.configure(bg='#EFEAE1')
    backdrop.lift()
    root.lift()
    root.attributes('-topmost', True)
    backdrop.lower(root)

    root.after(8600, lambda: (app.quit(), root.after(600, root.destroy)))
    root.mainloop()

    out_dir.mkdir(parents=True, exist_ok=True)
    produced: list[str] = []
    for source, target in RENAME.items():
        src = shots_dir / f'{source}.png'
        if not src.is_file():
            continue
        dst = out_dir / f'{target}.png'
        shutil.copyfile(src, dst)
        produced.append(str(dst))
    for item in produced:
        print('已生成', item)
    if not produced:
        print('没有生成截图，检查是否有报错。')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
