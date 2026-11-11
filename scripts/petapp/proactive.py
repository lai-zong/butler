"""桌面桌宠的主动提醒气泡。

★ 只负责展示与回应：说不说、什么频率、安静时段全部由主应用的
  `/api/pet/proactive/claim` 决定；这里不做任何本地判定。
★ 气泡贴着人物，位于人物上方（上方放不下时放到人物下方），
  不打开桌板，也不占用输入区。
"""

from __future__ import annotations

import tkinter as tk
from typing import Callable

from .theme import COLOR, Theme

class ProactiveReminder:
    def __init__(self, root: tk.Misc, theme: Theme) -> None:
        self.root = root
        self.t = theme
        self._win: tk.Toplevel | None = None

    @property
    def visible(self) -> bool:
        return self._win is not None

    def show(
        self,
        text: str,
        *,
        trigger: str,
        persona: str,
        center_x: int,
        pet_top: int,
        pet_bottom: int,
        on_action: Callable[[str], None],
    ) -> None:
        """在人物旁显示一条提醒；trigger/persona 不进入气泡标题。"""
        del trigger, persona
        self.hide()
        if not text.strip():
            return
        try:
            t = self.t
            win = tk.Toplevel(self.root)
            win.overrideredirect(True)
            win.attributes('-topmost', True)

            edge = tk.Frame(win, bg=COLOR['board_edge'], bd=0, padx=1, pady=1)
            edge.pack()
            card = tk.Frame(edge, bg=COLOR['board'], bd=0, padx=t.px(13), pady=t.px(10))
            card.pack()

            tk.Label(
                card,
                text=text,
                bg=COLOR['board'],
                fg=COLOR['ink'],
                font=t.fonts['quote'],
                justify='left',
                anchor='w',
                wraplength=t.px(252),
            ).pack(fill='x')

            actions = tk.Frame(card, bg=COLOR['board'])
            actions.pack(fill='x', pady=(t.px(9), 0))

            def add_button(label: str, action: str, primary: bool = False) -> None:
                tk.Button(
                    actions,
                    text=label,
                    bd=0,
                    relief='flat',
                    highlightthickness=0,
                    font=t.fonts['button'],
                    padx=t.px(9),
                    pady=t.px(3),
                    bg=COLOR['accent'] if primary else COLOR['board_soft'],
                    fg='#FFFDF8' if primary else COLOR['ink_2'],
                    activebackground=COLOR['accent_ink'] if primary else COLOR['hover'],
                    activeforeground='#FFFDF8' if primary else COLOR['ink'],
                    cursor='hand2',
                    command=lambda: self._answer(action, on_action),
                ).pack(side='left', padx=(0, t.px(6)))

            add_button('知道了', 'dismiss', True)
            add_button('稍后', 'snooze')
            add_button('别再提醒', 'mute')

            win.update_idletasks()
            width = win.winfo_reqwidth()
            height = win.winfo_reqheight()
            screen_w = win.winfo_screenwidth()
            screen_h = win.winfo_screenheight()

            x = max(6, min(center_x - width // 2, screen_w - width - 6))
            y = pet_top - height - t.px(8)
            if y < 6:
                y = pet_bottom + t.px(8)
            y = max(6, min(y, screen_h - height - 6))

            start_y = y + t.px(6)
            win.geometry(f'+{x}+{start_y}')
            try:
                win.attributes('-alpha', 0.0)
            except Exception:
                pass
            self._win = win

            def animate(step: int = 1) -> None:
                if self._win is not win or step > 6:
                    return
                try:
                    win.attributes('-alpha', step / 6)
                    win.geometry(f'+{x}+{start_y - round(t.px(6) * step / 6)}')
                except Exception:
                    return
                try:
                    self.root.after(18, lambda: animate(step + 1))
                except Exception:
                    pass

            animate()
        except Exception:
            # Tk 在某些窗口管理器下可能拒绝 overrideredirect；提醒失败不能崩主进程。
            try:
                win.destroy()
            except Exception:
                pass
            self._win = None

    def _answer(self, action: str, on_action: Callable[[str], None]) -> None:
        self.hide()
        try:
            on_action(action)
        except Exception:
            pass

    def hide(self) -> None:
        if self._win is None:
            return
        try:
            self._win.destroy()
        except Exception:
            pass
        self._win = None

    def destroy(self) -> None:
        self.hide()
