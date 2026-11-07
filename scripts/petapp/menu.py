"""桌宠右键菜单 —— 自绘、置顶、会翻转的弹层。

★ 为什么不用 tk.Menu：
  原生菜单做不了两行模型项，而且在 topmost 桌宠窗口旁边会被压住。
  这里是一个无边框 Toplevel + Canvas：菜单本身就是一块置顶窗口，
  打开时最后显示，因此不会被桌宠遮挡；靠近屏幕边缘时整块反转。

★ 菜单只保留五组：
  模型与思考强度 / 打开当前对话 / 窗口置顶 / 隐藏到托盘 / 退出。
  执行控制留在桌板内；剪贴板与会话管理不在这里。
"""

from __future__ import annotations

import math
import tkinter as tk
from typing import Any, Callable

from . import draw
from .draw import ellipsize, rounded_points
from .theme import COLOR, TRANSPARENT, Theme

THINKING_OPTIONS: tuple[tuple[str, str], ...] = (
    ('default', '默认'),
    ('low', '低'),
    ('medium', '中'),
    ('high', '高'),
)


class PetContextMenu:
    def __init__(
        self,
        root: tk.Tk,
        theme: Theme,
        *,
        models: list[dict[str, Any]],
        current_model_key: str,
        thinking_level: str,
        topmost: bool,
        web_active: bool,
        callbacks: dict[str, Callable[..., Any]],
    ) -> None:
        self.root = root
        self.t = theme
        self.models = models
        self.current_model_key = current_model_key
        self.thinking_level = thinking_level
        self.topmost = topmost
        self.web_active = web_active
        self.cb = callbacks

        self.W = theme.px(344)
        self.M = theme.px(18)
        self.full_h = 0
        self.view_h = 0
        self.offset = 0
        self._hover: str | None = None
        self._win: tk.Toplevel | None = None
        self._canvas: tk.Canvas | None = None

    # ═══════════════════════════════════════════════════
    # 打开 / 关闭
    # ═══════════════════════════════════════════════════

    def open_at(self, x_root: int, y_root: int) -> None:
        if self._win is not None:
            return
        self.full_h = self._measure_height()
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.view_h = min(self.full_h, max(self.t.px(240), sh - self.t.px(24)))

        win = tk.Toplevel(self.root)
        win.overrideredirect(True)
        win.configure(bg=TRANSPARENT)
        win.attributes('-topmost', True)
        try:
            win.attributes('-transparentcolor', TRANSPARENT)
        except Exception:
            pass
        win.bind('<Escape>', lambda _e: self.close())
        win.bind('<Button-1>', self._on_window_click, add='+')
        win.bind('<Button-3>', lambda _e: self.close(), add='+')
        win.bind('<MouseWheel>', self._on_wheel)
        self._win = win

        canvas = tk.Canvas(
            win, bg=TRANSPARENT, bd=0, highlightthickness=0, takefocus=0
        )
        canvas.pack(fill='both', expand=True)
        self._canvas = canvas

        x = x_root + self.t.px(4)
        y = y_root + self.t.px(6)
        if x + self.W > sw - self.t.px(12):
            x = x_root - self.W - self.t.px(6)
        if y + self.view_h > sh - self.t.px(12):
            y = y_root - self.view_h - self.t.px(10)
        x = max(self.t.px(10), min(x, sw - self.W - self.t.px(10)))
        y = max(self.t.px(10), min(y, sh - self.view_h - self.t.px(10)))
        win.geometry(f'{self.W}x{self.view_h}+{x}+{y}')
        self._draw()
        try:
            win.lift()
            win.focus_force()
            win.grab_set_global()
        except Exception:
            pass

    def close(self) -> None:
        win = self._win
        if win is None:
            return
        self._win = None
        self._canvas = None
        try:
            win.grab_release()
        except Exception:
            pass
        try:
            win.destroy()
        except Exception:
            pass
        try:
            self.cb['on_close']()
        except Exception:
            pass

    def _on_window_click(self, event: tk.Event) -> None:
        if event.x < 0 or event.y < 0 or event.x > self.W or event.y > self.view_h:
            self.close()

    def _on_wheel(self, event: tk.Event) -> str:
        if self.full_h <= self.view_h:
            return 'break'
        delta = -1 if event.delta > 0 else 1
        self.offset = max(
            0, min(self.full_h - self.view_h, self.offset + delta * self.t.px(28))
        )
        self._draw()
        return 'break'

    # ═══════════════════════════════════════════════════
    # 高度 / 布局
    # ═══════════════════════════════════════════════════

    def _model_row_h(self) -> int:
        return self.t.px(44)

    def _model_gap(self) -> int:
        return self.t.px(9)

    def _measure_height(self) -> int:
        y = self.t.px(14)
        y += self.t.px(18) + self.t.px(8)  # section
        if self.models:
            y += len(self.models) * self._model_row_h()
            y += max(0, len(self.models) - 1) * self._model_gap()
        else:
            y += self.t.px(38)
        y += self.t.px(8) + 1 + self.t.px(12)  # divider
        y += self.t.px(18) + self.t.px(8)  # thinking label
        y += self.t.px(28) + self.t.px(8)
        y += self.t.px(16) + self.t.px(18)  # hint
        y += 1 + self.t.px(10)  # divider
        y += self.t.px(46 if self.web_active else 38)
        y += self.t.px(38) * 2
        y += self.t.px(38) + self.t.px(4)
        y += self.t.px(38)
        y += self.t.px(14)
        return y

    # ═══════════════════════════════════════════════════
    # 绘制
    # ═══════════════════════════════════════════════════

    def _draw(self) -> None:
        c = self._canvas
        if c is None:
            return
        c.delete('all')
        W, H = self.W, self.view_h
        r = self.t.px(14)
        c.create_polygon(
            rounded_points(0, 0, W, H, r, r, r, r),
            fill=COLOR['field'], outline=COLOR['board_edge'],
            width=max(1, self.t.px(0.8)),
        )

        y = self.t.px(14) - self.offset
        y = self._section(c, '模型与思考强度', y)
        y += self.t.px(8)

        if self.models:
            for index, model in enumerate(self.models):
                key = f"{model.get('profileId', '')}::{model.get('modelId', '')}"
                self._model_row(c, y, index, model, key == self.current_model_key)
                y += self._model_row_h()
                if index != len(self.models) - 1:
                    y += self._model_gap()
        else:
            self._disabled_row(c, y, '未读取到模型')
            y += self.t.px(38)

        y += self.t.px(8)
        y = self._divider(c, y)
        y += self.t.px(12)

        y = self._section(c, '思考强度', y)
        y += self.t.px(8)
        y = self._thinking_row(c, y)
        y += self.t.px(8)
        c.create_text(
            self.M, y, anchor='nw', text='点选后同步到当前对话',
            font=self.t.fonts['menu_small'], fill=COLOR['ink_4'],
        )
        y += self.t.px(16) + self.t.px(18)

        y = self._divider(c, y)
        y += self.t.px(10)
        y = self._action_row(c, y, 'open', '打开当前对话', subtitle=(
            '主界面正在执行 · 点击打开' if self.web_active else ''
        ))
        y = self._action_row(c, y, 'topmost', '窗口置顶', checked=self.topmost)
        y = self._action_row(c, y, 'hide', '隐藏到托盘')
        y += self.t.px(4)
        y = self._action_row(c, y, 'quit', '退出', danger=True)

        if self.full_h > self.view_h:
            first = self.offset / max(1, self.full_h)
            last = min(1.0, (self.offset + self.view_h) / max(1, self.full_h))
            top = max(2.0, first * H + 2)
            bottom = min(H - 2.0, last * H - 2)
            if bottom - top < 18:
                bottom = top + 18
            c.create_line(
                W - self.t.px(5), top, W - self.t.px(5), bottom,
                fill=COLOR['ink_4'], width=max(2, self.t.px(2)), capstyle='round',
            )
        del y

    def _border_points(self, w: int, h: int, r: int) -> list[float]:
        pts: list[float] = []
        for i in range(9):
            a = math.radians(180 + 90 * (i / 8))
            pts.extend([r + math.cos(a) * r, r + math.sin(a) * r])
        pts.extend([w - r, 0.5])
        for i in range(9):
            a = math.radians(270 + 90 * (i / 8))
            pts.extend([w - r + math.cos(a) * r, r + math.sin(a) * r])
        pts.extend([w - 0.5, h - r])
        for i in range(9):
            a = math.radians(0 + 90 * (i / 8))
            pts.extend([w - r + math.cos(a) * r, h - r + math.sin(a) * r])
        pts.extend([r, h - 0.5])
        for i in range(9):
            a = math.radians(90 + 90 * (i / 8))
            pts.extend([r + math.cos(a) * r, h - r + math.sin(a) * r])
        pts.extend([0.5, r])
        return pts

    def _section(self, c: tk.Canvas, text: str, y: float) -> float:
        c.create_text(
            self.M, y, text=text, anchor='nw',
            font=self.t.fonts['menu_title'], fill=COLOR['ink_3'],
        )
        return y + self.t.px(18)

    def _divider(self, c: tk.Canvas, y: float) -> float:
        c.create_line(
            self.M, y, self.W - self.M, y,
            fill=COLOR['divider'], width=1,
        )
        return y + 1

    def _disabled_row(self, c: tk.Canvas, y: float, text: str) -> None:
        h = self.t.px(38)
        c.create_text(
            self.M, y + h / 2, text=text, anchor='w',
            font=self.t.fonts['menu_item'], fill=COLOR['ink_4'],
        )

    def _model_row(
        self,
        c: tk.Canvas,
        y: float,
        index: int,
        model: dict[str, Any],
        selected: bool,
    ) -> None:
        tag = f'model{index}'
        h = self._model_row_h()
        hover = self._hover == tag
        if selected or hover:
            c.create_polygon(
                rounded_points(
                    self.M - self.t.px(6), y,
                    self.W - self.M + self.t.px(6), y + h,
                    self.t.px(10), self.t.px(10), self.t.px(10), self.t.px(10),
                ),
                fill=COLOR['accent_soft'] if selected else COLOR['hover'],
                outline='', tags=(tag,),
            )
        else:
            c.create_rectangle(
                self.M - self.t.px(6), y,
                self.W - self.M + self.t.px(6), y + h,
                fill=COLOR['field'], outline='', tags=(tag,),
            )
        if selected:
            draw.icon_check(
                c, self.M + self.t.px(4), y + h / 2, self.t.px(9),
                COLOR['accent_ink'], width=self.t.px(1.7), tag=tag,
            )
        text_x = self.M + self.t.px(22)
        config_name = str(model.get('profileName') or model.get('profileId') or '模型配置')
        model_name = str(model.get('modelId') or '')
        max_w = int(self.W - text_x - self.M)
        c.create_text(
            text_x, y + self.t.px(10), anchor='nw',
            text=ellipsize(self.t.fonts['menu_small'], config_name, max_w),
            font=self.t.fonts['menu_small'], fill=COLOR['ink_3'], tags=(tag,),
        )
        c.create_text(
            text_x, y + self.t.px(26), anchor='nw',
            text=ellipsize(self.t.fonts['menu_model'], model_name, max_w),
            font=self.t.fonts['menu_model'], fill=COLOR['ink'], tags=(tag,),
        )
        self._bind_tag(c, tag, lambda: self._choose_model(index))

    def _thinking_row(self, c: tk.Canvas, y: float) -> float:
        gap = self.t.px(6)
        h = self.t.px(28)
        total = self.W - 2 * self.M - gap * (len(THINKING_OPTIONS) - 1)
        width = total / len(THINKING_OPTIONS)
        for index, (value, label) in enumerate(THINKING_OPTIONS):
            tag = f'thinking{index}'
            x = self.M + index * (width + gap)
            selected = value == self.thinking_level
            hover = self._hover == tag
            c.create_polygon(
                rounded_points(
                    x, y, x + width, y + h,
                    self.t.px(9), self.t.px(9), self.t.px(9), self.t.px(9),
                ),
                fill=COLOR['accent_soft'] if selected else (
                    COLOR['hover'] if hover else COLOR['board_soft']
                ),
                outline=COLOR['accent_line'] if selected else COLOR['field'],
                width=1, tags=(tag,),
            )
            c.create_text(
                x + width / 2, y + h / 2, text=label, anchor='center',
                font=self.t.fonts['menu_item'],
                fill=COLOR['accent_ink'] if selected else COLOR['ink_2'],
                tags=(tag,),
            )
            self._bind_tag(c, tag, lambda v=value: self._choose_thinking(v))
        return y + h

    def _action_row(
        self,
        c: tk.Canvas,
        y: float,
        tag: str,
        label: str,
        *,
        subtitle: str = '',
        checked: bool = False,
        danger: bool = False,
    ) -> float:
        h = self.t.px(46 if subtitle else 38)
        hover = self._hover == tag
        full_tag = f'action{tag}'
        if hover:
            c.create_polygon(
                rounded_points(
                    self.M - self.t.px(6), y,
                    self.W - self.M + self.t.px(6), y + h,
                    self.t.px(9), self.t.px(9), self.t.px(9), self.t.px(9),
                ),
                fill=COLOR['hover'], outline='', tags=(full_tag,),
            )
        else:
            c.create_rectangle(
                self.M - self.t.px(6), y,
                self.W - self.M + self.t.px(6), y + h,
                fill=COLOR['field'], outline='', tags=(full_tag,),
            )
        ink = COLOR['danger'] if danger else COLOR['ink']
        if subtitle:
            c.create_text(
                self.M, y + self.t.px(8), text=label, anchor='nw',
                font=self.t.fonts['menu_item'], fill=ink, tags=(full_tag,),
            )
            c.create_text(
                self.M, y + self.t.px(27), text=subtitle, anchor='nw',
                font=self.t.fonts['menu_small'], fill=COLOR['ink_4'],
                tags=(full_tag,),
            )
        else:
            c.create_text(
                self.M, y + h / 2, text=label, anchor='w',
                font=self.t.fonts['menu_item'], fill=ink, tags=(full_tag,),
            )
        if checked:
            draw.icon_check(
                c, self.W - self.M - self.t.px(5), y + h / 2, self.t.px(10),
                COLOR['accent_ink'], width=self.t.px(1.7), tag=full_tag,
            )
        action = {
            'open': lambda: self._run(self.cb['open_conversation']),
            'topmost': lambda: self._run(self.cb['toggle_topmost']),
            'hide': lambda: self._run(self.cb['hide_pet']),
            'quit': lambda: self._run(self.cb['quit']),
        }[tag]
        self._bind_tag(c, full_tag, action)
        return y + h

    # ═══════════════════════════════════════════════════
    # 事件
    # ═══════════════════════════════════════════════════

    def _bind_tag(self, c: tk.Canvas, tag: str, action: Callable[[], None]) -> None:
        c.tag_bind(tag, '<Button-1>', lambda _e: action())
        c.tag_bind(tag, '<Enter>', lambda _e, n=tag: self._set_hover(n))
        c.tag_bind(tag, '<Leave>', lambda _e: self._set_hover(None))

    def _set_hover(self, tag: str | None) -> None:
        if self._hover == tag:
            return
        self._hover = tag
        try:
            if self._canvas is not None:
                self._canvas.configure(cursor='hand2' if tag else '')
        except Exception:
            pass
        self._draw()

    def _choice(self, action: Callable[..., Any], *args: Any) -> None:
        self.close()
        try:
            action(*args)
        except Exception:
            pass

    def _run(self, action: Callable[..., Any], *args: Any) -> None:
        self._choice(action, *args)

    def _choose_model(self, index: int) -> None:
        if 0 <= index < len(self.models):
            self._choice(self.cb['choose_model'], self.models[index])

    def _choose_thinking(self, value: str) -> None:
        self._choice(self.cb['choose_thinking'], value)
