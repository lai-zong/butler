"""把人物、桌板、托盘、菜单、后台轮询接在一起。

★ 一条铁律：**所有 Tk 操作只在主线程**。
  网络、配置、托盘、语音、附件解析都在别的线程里跑，
  它们只能往队列里放消息，由主线程的 `_poll` 统一取出来处理。
  Tk 不是线程安全的，跨线程碰控件会随机崩 —— 而且崩在无关的地方。

★ 另一条：配置以主应用为准，主应用不在时退回本地 `pet-config.json`。
  这样设置页改完能立刻看到，主应用没开时桌宠也记得住上次的偏好。
"""

from __future__ import annotations

import ctypes
import os
import queue
import sys
import threading
import time
import tkinter as tk
import urllib.parse
import webbrowser
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageTk

from . import chat as chatmod
from . import webwindow
from .api import ApiError, ButlerApi
from .board import BoardView
from .menu import PetContextMenu
from .proactive import ProactiveReminder
from .store import (
    ASSET_DIR,
    Paths,
    load_config,
    load_state,
    normalize_config,
    reasoning_for_thinking_level,
    save_config,
    save_state,
)
from .theme import COLOR, TRANSPARENT, Theme
from .tray import SystemTray

APP_TITLE = 'butler 桌宠'
BADGE_BG = (177, 87, 60)
BADGE_INK = (255, 247, 235)

_GET_ANCESTOR_GA_ROOT = 2
_HWND_TOPMOST = -1
_HWND_NOTOPMOST = -2
_SWP_NOACTIVATE = 0x0010
_SWP_SHOWWINDOW = 0x0040
_SWP_FLAGS = 0x0002 | 0x0001 | _SWP_NOACTIVATE | _SWP_SHOWWINDOW  # NOMOVE | NOSIZE | NOACTIVATE | SHOWWINDOW


class PetApp:
    def __init__(self, root: tk.Tk, *, demo: bool = False, snap_dir: str | None = None) -> None:
        self.root = root
        self.demo = demo
        self.snap_dir = snap_dir
        self.paths = Paths()
        self.theme = Theme(root)
        self.config = load_config(self.paths)
        self.state = load_state(self.paths)
        self.api = ButlerApi()
        self.events: queue.Queue[tuple[Any, ...]] = queue.Queue()
        # 主动提醒气泡：只在主线程操作，网络由 _poll_proactive 的工作线程负责。
        self.proactive = ProactiveReminder(self.root, self.theme)

        self._closing = False
        self._board_h = 0
        self._board_open = False
        self._window_w = 0
        self._pet_w = 0
        self._pet_h = 0
        self._pet_x = 0
        self._board_w = 0
        self._x = 40
        self._y_rest = 110
        self._y = 110
        saved_x = self.state.get('x')
        saved_y = self.state.get('y')
        if isinstance(saved_x, int) and isinstance(saved_y, int):
            self._x = saved_x
            self._y_rest = saved_y
            self._y = saved_y
        self._drag: dict[str, Any] | None = None
        self._due: list[dict[str, Any]] = []
        self._chat_models: list[dict[str, Any]] = []
        self._models_loading = False
        self._session_id = self.state.get('sessionId')
        if not isinstance(self._session_id, str) or not self._session_id:
            self._session_id = None
        # 桌面和 Web 悬浮桌宠共用服务端固定的宠物会话。
        # 旧主应用没有这个端点时保持本地 state，不影响启动。
        if not self.demo:
            server_session = self.api.pet_session()
            if server_session:
                self._session_id = server_session
                self.state['sessionId'] = server_session
                save_state(self.paths, self.state)
        self._badge_font: Any = None
        self._photo: ImageTk.PhotoImage | None = None
        self._sprite: Image.Image | None = None
        self._board_top = 0
        self._web_active: list[dict[str, Any]] = []
        self._menu_open = False
        self._menu: PetContextMenu | None = None
        self._tray: SystemTray | None = None
        self._notified_offline = False
        # 历史读取：只在启动/会话确定/每轮结束/打开桌板时触发；
        # 绘制与滚动永远不碰网络。
        self._history_loading = False
        self._history_pending = False
        self._history_loaded = False
        self._history_last_attempt = 0.0
        self._history_session = ''
        self._history_last_error = ''
        # ⚠️ pystray 在**它自己的线程**里读菜单状态；Tk 的 root.state() 不能在
        #    别的线程里碰。所以这里维护一份普通 dict 快照，托盘只读它。
        self._tray_snapshot: dict[str, Any] = {
            'visible': True,
            'running': False,
            'topmost': bool(self.config.get('alwaysOnTop', True)),
            'due': 0,
        }

        self._setup_window()
        self._load_sprite()
        self._build_widgets()
        self._build_board()
        self._render_pet()
        self._apply_window()

        self.chat = chatmod.ChatController(
            self.api,
            self._chat_emit,
            session_id=self._session_id,
            # ⚠️ 这个回调在**工作线程**里触发；直接改界面会在随机时刻崩。
            on_session=lambda sid: self.events.put(('session_id', sid)),
            config_provider=lambda: self.config,
            demo=demo,
        )

        self._bind_window()
        self.root.after(60, self._poll)
        self.root.after(200, self._start_services)
        self._refresh_tray()

    # ═══════════════════════════════════════════════════
    # 窗口与人物
    # ═══════════════════════════════════════════════════

    def _setup_window(self) -> None:
        self.root.overrideredirect(True)
        self.root.configure(bg=TRANSPARENT)
        try:
            self.root.attributes('-transparentcolor', TRANSPARENT)
        except Exception:
            pass
        self._apply_topmost()
        self.root.title(APP_TITLE)

    def _load_sprite(self) -> None:
        sprite_id = str(self.config.get('sprite') or 'butler')
        path = ASSET_DIR / sprite_id / 'base.png'
        if not path.is_file():
            path = ASSET_DIR / 'butler' / 'base.png'
        image = Image.open(path).convert('RGBA')
        # AI 导出的透明 PNG 在"透明区"常带 alpha 1~15 的彩色噪点：
        # Tk 的 -transparentcolor 会把它和底色混成麻点，先清掉。
        alpha = image.getchannel('A').point(lambda v: 0 if v < 64 else (255 if v >= 250 else v))
        image.putalpha(alpha)
        image, table_top, bottom = self._clean_table_edge(image)
        crop = image.crop((0, 0, image.width, bottom + 1))
        target_h = int(self.config.get('size', 220))
        ratio = target_h / max(1, crop.height)
        sprite = crop.resize(
            (max(80, int(crop.width * ratio)), target_h), Image.Resampling.LANCZOS
        )
        # LANCZOS 会重新造出半透明边缘；在最终尺寸上二值化，避免黑边
        sprite.putalpha(sprite.getchannel('A').point(lambda v: 255 if v >= 128 else 0))
        self._sprite = sprite
        self._pet_w = sprite.width
        self._pet_h = target_h
        # 桌板上沿接在人物手部那一行（也就是原图台沿的顶边）。
        self._board_top = max(0, min(target_h - 1, round(table_top / max(1, crop.height) * target_h)))
        self._board_w = self._compute_board_w()
        try:
            self._badge_font = ImageFont.truetype(
                'C:/Windows/Fonts/msyhbd.ttc', max(9, self.theme.px(10))
            )
        except Exception:
            self._badge_font = None

    @staticmethod
    def _clean_table_edge(image: Image.Image) -> tuple[Image.Image, int, int]:
        """去掉人物图自带的台沿黑线，返回 (清理后的图, 台沿顶边, 内容底边)。

        这个素材的下沿有一整条黑色台沿，下面只剩两只手。桌板要贴在台沿
        原来的位置，所以把台沿按行抹掉；手的横向区间保留，桌面由桌板接手。
        """
        width, height = image.size
        pixels = image.load()
        bottom = height - 1
        while bottom > 0:
            row = [pixels[x, bottom][3] for x in range(0, width, 8)]
            if any(a > 200 for a in row):
                break
            bottom -= 1

        scan_from = max(0, bottom - int(height * 0.2))
        groups: list[tuple[int, int]] = []
        start: int | None = None
        for y in range(scan_from, bottom + 1):
            dark = 0
            for x in range(0, width, 2):
                r, g, b, a = pixels[x, y]
                if a > 200 and max(r, g, b) < 110:
                    dark += 1
            broad = dark > (width // 2) * 0.55
            if broad and start is None:
                start = y
            elif not broad and start is not None:
                groups.append((start, y - 1))
                start = None
        if start is not None:
            groups.append((start, bottom))
        if not groups:
            return image, bottom, bottom

        line_top, line_bottom = groups[-1]
        # 台沿的柔化边在检测行上方一行；从那里开始由桌板接住。
        line_top = max(0, line_top - 1)
        probe = min(bottom, line_bottom + 2)
        runs: list[tuple[int, int]] = []
        run_start: int | None = None
        for x in range(width):
            opaque = pixels[x, probe][3] > 200
            if opaque and run_start is None:
                run_start = x
            elif not opaque and run_start is not None:
                if x - run_start > width * 0.015:
                    runs.append((run_start - 3, x + 2))
                run_start = None
        if run_start is not None and width - run_start > width * 0.015:
            runs.append((run_start - 3, width - 1))

        remove_to = min(bottom, line_bottom + 4)
        for y in range(line_top, remove_to + 1):
            for x in range(width):
                keep = any(a <= x <= b for a, b in runs)
                if not keep:
                    pixels[x, y] = (0, 0, 0, 0)

        while bottom > 0:
            row = [pixels[x, bottom][3] for x in range(0, width, 8)]
            if any(a > 60 for a in row):
                break
            bottom -= 1
        return image, line_top, bottom

    def _compute_board_w(self) -> int:
        """桌板宽度跟着人物走：太窄放不下两句中文，太宽就像个网页。"""
        logical = self._pet_w / max(0.1, self.theme.scale) * 1.55
        return int(max(372, min(420, round(logical))))

    def _build_widgets(self) -> None:
        self.pet_frame = tk.Frame(
            self.root, bg=TRANSPARENT, bd=0, highlightthickness=0, cursor='hand2'
        )
        self.pet_frame.pack(side='top', fill='x')
        self.pet_frame.pack_propagate(False)
        self.pet_label = tk.Label(
            self.pet_frame, bg=TRANSPARENT, bd=0, highlightthickness=0, cursor='hand2'
        )
        self.pet_label.place(x=0, y=0)

    def _build_board(self) -> None:
        self._window_w = max(self.theme.px(self._board_w), self._pet_w)
        self.pet_frame.configure(width=self._window_w, height=self._pet_h)
        self.pet_label.place(x=0, y=0, width=self._window_w, height=self._pet_h)
        self._pet_x = (self._window_w - self._pet_w) // 2

        # 桌板是独立窗口：人物窗口在上，桌板窗口在下。
        # 人物图透明处会真的露出桌板，因此手压在桌板上时不会再有接缝。
        self.board_window = tk.Toplevel(self.root)
        self.board_window.overrideredirect(True)
        self.board_window.configure(bg=TRANSPARENT)
        try:
            self.board_window.attributes('-transparentcolor', TRANSPARENT)
        except Exception:
            pass
        self.board_window.withdraw()
        self.board_frame = tk.Frame(
            self.board_window, bg=TRANSPARENT, bd=0, highlightthickness=0
        )
        self.board_frame.pack(fill='both', expand=True)

        callbacks = {
            'on_height': self._on_board_height,
            'on_show': self._on_board_show,
            'on_hide': self._on_board_hide,
            'focus_window': self._focus_board,
            'on_send': self._on_send,
            'on_stop': self._on_stop,
            'on_open_conversation': self.open_conversation,
            'on_check_connection': self._check_connection,
            'on_context_menu': self._on_context_menu,
        }
        self.board = BoardView(
            self.root,
            self.board_frame,
            self.theme,
            self._board_w,
            self.api,
            callbacks,
            demo=self.demo,
        )
        self._update_max_board_h()
        self._apply_window()
        try:
            self.board_window.geometry(
                f'{self.board.W}x1+{self._x + self._board_x()}+{self._y + self._ledger_y()}'
            )
        except Exception:
            pass
        self._board_open = False

    def _update_max_board_h(self) -> None:
        """桌板最多长到屏幕底边留出一点空 —— 再长就没人能看全了。"""
        _sw, sh = self._screen()
        self.board.max_board_h = max(
            self.theme.px(240), sh - self._ledger_y() - self.theme.px(24)
        )

    def _render_pet(self) -> None:
        if self._sprite is None:
            return
        width = self._window_w
        image = Image.new('RGBA', (width, self._pet_h), (0, 0, 0, 0))
        image.alpha_composite(self._sprite, (self._pet_x, 0))
        if self._due:
            self._draw_badge(image)
        self._photo = ImageTk.PhotoImage(image)
        self.pet_label.configure(image=self._photo)
        self.pet_label.place(x=0, y=0, width=width, height=self._pet_h)

    def _ledger_y(self) -> int:
        return max(0, min(self._pet_h - 1, int(self._board_top)))

    def _board_x(self) -> int:
        return (self._window_w - self.board.W) // 2

    def _draw_badge(self, image: Image.Image) -> None:
        radius = self.theme.px(8.5)
        cx = self._pet_x + self._pet_w - self.theme.px(3)
        cy = self.theme.px(11)
        draw = ImageDraw.Draw(image)
        draw.ellipse(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            fill=(*BADGE_BG, 255),
            outline=(255, 250, 240, 255),
            width=max(1, self.theme.px(1.2)),
        )
        text = str(min(len(self._due), 9)) if self._due else '!'
        if self._badge_font is not None:
            draw.text((cx, cy), text, font=self._badge_font, fill=(*BADGE_INK, 255), anchor='mm')

    # ═══════════════════════════════════════════════════
    # 几何
    # ═══════════════════════════════════════════════════

    def _screen(self) -> tuple[int, int]:
        return int(self.root.winfo_screenwidth()), int(self.root.winfo_screenheight())

    def _apply_window(self) -> None:
        sw, sh = self._screen()
        board_h = self._board_h if self.board.open else 0
        ledger = self._ledger_y()
        # 贴边的是**人物**，不是桌板。窗口比人物宽（要容纳桌板），所以允许
        # 窗口坐标甚至桌板伸出屏幕：人物左/右边界才是和屏幕对齐的那条线。
        min_x = -self._pet_x
        max_x = sw - self._pet_x - self._pet_w
        x = min(max(min_x, int(self._x)), max(min_x, max_x))
        # 纵向同理：按人物高度贴边。桌板高度不再把人物往上推 —— 桌板向
        # 屏幕下方伸出去是允许的，人物位置只由自己的高度决定。
        desired = max(0, min(int(self._y_rest), max(0, sh - self._pet_h)))
        self._x = x
        # 把限制后的纵向位置写回，拖动/保存/下次启动都沿用同一条几何规则。
        self._y_rest = desired
        self._y = desired
        self.root.geometry(f'{self._window_w}x{self._pet_h}+{x}+{desired}')
        # Tk 的 wm geometry 是异步的；桌板窗口随后移动时，根窗有时会停留在
        # 旧位置，表现为“桌宠在左上角、提示条在右下角”。用 SetWindowPos
        # 同步一次物理位置，保证两块窗口永远贴在一起。
        if sys.platform == 'win32' and self.root.state() != 'withdrawn':
            try:
                user32 = ctypes.windll.user32
                root_hwnd = self._hwnd(self.root)
                enabled = bool(self.config.get('alwaysOnTop', True))
                flag = _HWND_TOPMOST if enabled else _HWND_NOTOPMOST
                if root_hwnd:
                    user32.SetWindowPos(
                        root_hwnd, flag, x, desired,
                        self._window_w, self._pet_h,
                        _SWP_NOACTIVATE | _SWP_SHOWWINDOW,
                    )
            except Exception:
                pass
        if board_h > 0:
            bx = x + self._board_x()
            by = desired + ledger
            try:
                self.board_window.geometry(
                    f'{self.board.W}x{max(1, int(board_h))}+{bx}+{by}'
                )
            except Exception:
                pass
            if self.root.state() != 'withdrawn':
                try:
                    self.board_window.deiconify()
                except Exception:
                    pass
                if sys.platform == 'win32':
                    try:
                        user32 = ctypes.windll.user32
                        board_hwnd = self._hwnd(self.board_window)
                        enabled = bool(self.config.get('alwaysOnTop', True))
                        flag = _HWND_TOPMOST if enabled else _HWND_NOTOPMOST
                        if board_hwnd:
                            user32.SetWindowPos(
                                board_hwnd, flag, bx, by,
                                self.board.W, max(1, int(board_h)),
                                _SWP_NOACTIVATE | _SWP_SHOWWINDOW,
                            )
                    except Exception:
                        pass
                self._raise_pet_above_board()

    def _on_board_height(self, height: int) -> None:
        if height == self._board_h:
            self._apply_window()
            return
        self._board_h = max(0, int(height))
        self._board_open = self._board_h > 2
        self._apply_window()
        if self._board_h <= 1:
            self._on_board_hide()

    def _on_board_show(self) -> None:
        if self.root.state() == 'withdrawn':
            return
        # 打开桌板时收回主动气泡，避免两块浮层叠在一起。
        try:
            self.proactive.hide()
        except Exception:
            pass
        try:
            self.board_window.deiconify()
        except Exception:
            pass
        self._apply_topmost()
        self._apply_window()
        self._raise_pet_above_board()

    def _on_board_hide(self) -> None:
        if self._closing:
            return
        if self.board.open:
            return
        try:
            self.board_window.withdraw()
        except Exception:
            pass

    def _focus_board(self) -> None:
        if self.board_window.state() == 'withdrawn':
            return
        try:
            self.board_window.focus_force()
        except Exception:
            pass
        if sys.platform == 'win32':
            try:
                user32 = ctypes.windll.user32
                hwnd = int(self.board_window.winfo_id())
                target = user32.GetAncestor(hwnd, _GET_ANCESTOR_GA_ROOT) or hwnd
                user32.SetForegroundWindow(target)
            except Exception:
                pass
        # 输入焦点在桌板窗口，但视觉层次要保持人物在桌板之上。
        self.root.after(20, self._raise_pet_above_board)

    def _focus_window(self) -> None:
        self._focus_board()

    def _hwnd(self, window: tk.Misc) -> int:
        try:
            hwnd = int(window.winfo_id())
            user32 = ctypes.windll.user32
            return int(user32.GetAncestor(hwnd, _GET_ANCESTOR_GA_ROOT) or hwnd)
        except Exception:
            return 0

    def _raise_pet_above_board(self) -> None:
        if self._closing or self._menu_open:
            return
        if self.root.state() == 'withdrawn':
            return
        if sys.platform != 'win32':
            try:
                self.root.lift()
            except Exception:
                pass
            return
        # ⚠️ 不能用 SWP_NOMOVE 抢 z-order：Tk 的 wm geometry 还是异步的，
        #    NOMOVE 会把尚未提交的新位置“按”回旧坐标。这里显式带上目标
        #    坐标，顺便完成移动与置顶。
        try:
            user32 = ctypes.windll.user32
            root_hwnd = self._hwnd(self.root)
            board_hwnd = self._hwnd(self.board_window)
            enabled = bool(self.config.get('alwaysOnTop', True))
            flag = _HWND_TOPMOST if enabled else _HWND_NOTOPMOST
            bx = self._x + self._board_x()
            by = self._y + self._ledger_y()
            if self.board.open and board_hwnd:
                user32.SetWindowPos(
                    board_hwnd, flag, bx, by, self.board.W,
                    max(1, int(self._board_h)),
                    _SWP_NOACTIVATE | _SWP_SHOWWINDOW,
                )
            if root_hwnd:
                user32.SetWindowPos(
                    root_hwnd, flag, self._x, self._y,
                    self._window_w, self._pet_h,
                    _SWP_NOACTIVATE | _SWP_SHOWWINDOW,
                )
        except Exception:
            pass

    def _apply_topmost(self) -> None:
        enabled = bool(self.config.get('alwaysOnTop', True))
        for window in (self.root, getattr(self, 'board_window', None)):
            if window is None:
                continue
            try:
                window.attributes('-topmost', enabled)
            except Exception:
                pass
        if sys.platform != 'win32':
            return
        try:
            user32 = ctypes.windll.user32
            flag = _HWND_TOPMOST if enabled else _HWND_NOTOPMOST
            board_hwnd = self._hwnd(self.board_window)
            root_hwnd = self._hwnd(self.root)
            if board_hwnd:
                user32.SetWindowPos(board_hwnd, flag, 0, 0, 0, 0, _SWP_FLAGS)
            if root_hwnd:
                user32.SetWindowPos(root_hwnd, flag, 0, 0, 0, 0, _SWP_FLAGS)
        except Exception:
            pass

    def _keep_topmost(self) -> None:
        if self._closing:
            return
        if (
            not self._menu_open
            and self.config.get('alwaysOnTop', True)
            and self.root.state() != 'withdrawn'
        ):
            self._apply_topmost()
            self._raise_pet_above_board()
        self.root.after(4000, self._keep_topmost)

    # ═══════════════════════════════════════════════════
    # 人物交互
    # ═══════════════════════════════════════════════════

    def _bind_window(self) -> None:
        for widget in (self.pet_frame, self.pet_label):
            widget.bind('<ButtonPress-1>', self._on_pet_press)
            widget.bind('<B1-Motion>', self._on_pet_drag)
            widget.bind('<ButtonRelease-1>', self._on_pet_release)
            widget.bind('<Button-3>', self._on_context_menu)
            widget.bind('<Double-Button-1>', lambda _e: self.open_current_conversation())
        self.root.bind_all('<Escape>', self._on_escape, add='+')

    def _on_pet_press(self, event: tk.Event) -> None:
        # 用户抓住人物（拖动或打开桌板）时，先收起主动气泡。
        try:
            self.proactive.hide()
        except Exception:
            pass
        self._drag = {
            'x': event.x_root,
            'y': event.y_root,
            'wx': self._x,
            'wy': self._y,
            'moved': False,
        }

    def _on_pet_drag(self, event: tk.Event) -> None:
        if self._drag is None:
            return
        dx = event.x_root - self._drag['x']
        dy = event.y_root - self._drag['y']
        if abs(dx) + abs(dy) > 4:
            self._drag['moved'] = True
        self._x = self._drag['wx'] + dx
        self._y_rest = self._drag['wy'] + dy
        self._apply_window()

    def _on_pet_release(self, _event: tk.Event) -> None:
        moved = bool(self._drag and self._drag.get('moved'))
        self._drag = None
        self._remember_position()
        if moved:
            return
        self.toggle_board()

    def _remember_position(self) -> None:
        try:
            self.state['x'] = int(self._x)
            self.state['y'] = int(self._y_rest)
            save_state(self.paths, self.state)
        except Exception:
            pass

    def _on_escape(self, _event: tk.Event | None = None) -> str:
        if self.board.handle_escape():
            return 'break'
        return ''

    # ═══════════════════════════════════════════════════
    # 桌板动作
    # ═══════════════════════════════════════════════════

    def toggle_board(self) -> None:
        if self.board.open:
            self.board.close_board()
        else:
            self.open_board()

    def open_board(self) -> None:
        if not self.board.open:
            self.board.open_board()
        # 打开即读一次；in-flight 合并 + 短节流，连续点开不会叠请求。
        self._load_history('open', min_interval=1.5)

    def _on_send(self, payload: str, images: list[str]) -> None:
        if self.chat.running:
            self.board.flash('上一轮还在执行，先点停止', 'warn')
            return
        if not self.chat.start(payload, images):
            self.board.set_error('没能开始这一轮，再点一次发送试试。')

    def _on_stop(self) -> None:
        if not self.chat.running:
            return
        # 不在桌板外再弹一条"正在停止"提示；取消结果就写在桌板正文里。
        self.chat.cancel()

    def _conversation_url(self, session_id: str | None) -> str:
        base = self.api.base_url.rstrip('/')
        if session_id:
            return f"{base}/?session={urllib.parse.quote(session_id)}#/chat"
        return f'{base}/#/chat'

    def open_conversation(self, session_id: str | None = None) -> None:
        """打开某条对话：已有 Web 窗口就地聚焦，只有没有窗口时才新开。

        ★ 不优先 `_web_active`：那是"主界面里别人正在执行"的气泡，
          用户点"打开当前对话"要回到的是**桌宠自己**这条会话。
          外部气泡要跳别的会话时，显式传 session_id（board 已经这么做）。
        """
        target = session_id if isinstance(session_id, str) and session_id.strip() else None
        if not target:
            target = self._session_id
        url = self._conversation_url(target)

        if webwindow.available():
            try:
                hwnd = webwindow.find_butler_window()
            except Exception:
                hwnd = 0
            if hwnd:
                # 先聚焦再 POST：即使 POST 因旧服务 404 / 网络不通失败，
                # 用户也已经回到那个页面，而不是又弹出一个新窗口。
                try:
                    webwindow.focus_window(hwnd)
                except Exception:
                    pass
                if target:
                    try:
                        self.api.focus_session(target)
                    except Exception:
                        pass
                return

        try:
            webbrowser.open(url)
        except Exception as err:
            self.board.flash(f'打不开浏览器：{err}', 'warn')

    def open_current_conversation(self) -> None:
        # 桌宠自己的会话优先；chat 的 session 比事件队列早一步更新时也能跟上。
        target = self._session_id
        if not target:
            target = getattr(getattr(self, 'chat', None), 'session_id', None)
        self.open_conversation(target if isinstance(target, str) else None)

    def open_web(self) -> None:
        self.open_current_conversation()

    # ═══════════════════════════════════════════════════
    # 菜单
    # ═══════════════════════════════════════════════════

    def _current_model_key(self) -> str:
        current = self.config.get('model')
        if not isinstance(current, dict):
            return ''
        return f"{current.get('profileId', '')}::{current.get('modelId', '')}"

    def _on_context_menu(self, event: tk.Event) -> None:
        self._show_context_menu(int(event.x_root), int(event.y_root))

    def _show_context_menu(self, x_root: int, y_root: int) -> None:
        if self._closing:
            return
        if self._menu is not None:
            self._menu.close()
        active = self._web_active[0] if self._web_active else None
        self._menu_open = True
        self._menu = PetContextMenu(
            self.root,
            self.theme,
            models=self._chat_models,
            current_model_key=self._current_model_key(),
            thinking_level=str(self.config.get('thinkingLevel') or 'default'),
            topmost=bool(self.config.get('alwaysOnTop', True)),
            web_active=active is not None,
            callbacks={
                'open_conversation': self.open_current_conversation,
                'toggle_topmost': self._toggle_topmost,
                'hide_pet': self.hide_pet,
                'quit': self.quit,
                'choose_model': self._set_model,
                'choose_thinking': self._set_thinking,
                'on_close': self._on_menu_closed,
            },
        )
        self._menu.open_at(x_root, y_root)
        if not self._chat_models:
            self._load_models()

    def _on_menu_closed(self) -> None:
        self._menu_open = False
        self._menu = None
        self._apply_topmost()
        self._raise_pet_above_board()

    def _patch_session_settings(self, patch: dict[str, Any]) -> None:
        """把桌宠右键改动同步到**对应会话**（session 是权威）。

        ★ 没有会话时先建一个空会话再 PATCH；不把设置只留在 pet-config 里，
          否则 Web 与桌宠会看到两份不同的设置。
        ★ 旧主应用没有 PATCH 接口时静默降级（404/405），
          聊天请求里的旧 `model` / `thinkingLevel` 仍能兜底。
        """
        if not patch:
            return

        def worker() -> None:
            session_id = self.chat.session_id or self._session_id
            if not session_id:
                try:
                    session_id = self.api.create_session()
                except ApiError as err:
                    self.events.put(('toast', f'设置没有同步到对话：{err}', 'warn'))
                    return
                self.events.put(('session_id', session_id))
            try:
                self.api.patch_session(session_id, patch)
            except ApiError as err:
                if err.status not in (404, 405):
                    self.events.put(('toast', f'设置没有同步到当前对话：{err}', 'warn'))

        threading.Thread(target=worker, daemon=True).start()

    def _set_model(self, option: dict[str, Any]) -> None:
        choice = {
            'profileId': str(option.get('profileId', '')),
            'modelId': str(option.get('modelId', '')),
            'label': str(option.get('label') or option.get('modelId') or ''),
        }
        if not choice['profileId'] or not choice['modelId']:
            return
        self.config['model'] = choice
        save_config(self.paths, self.config)
        self.board.flash('已切换模型')
        self._patch_session_settings({
            'modelProfileId': choice['profileId'],
            'modelId': choice['modelId'],
        })

        def worker() -> None:
            try:
                cfg = self.api.put_config({'model': choice})
                self.events.put(('saved_config', cfg))
            except ApiError as err:
                self.events.put(('toast', f'模型没存进主应用：{err}', 'warn'))

        threading.Thread(target=worker, daemon=True).start()

    def _set_thinking(self, level: str) -> None:
        reasoning = reasoning_for_thinking_level(level)
        if reasoning is None:
            return
        self.config['thinkingLevel'] = level
        save_config(self.paths, self.config)
        self.board.flash('思考强度已同步到当前对话')
        self._patch_session_settings({'reasoning': reasoning})

        def worker() -> None:
            try:
                cfg = self.api.put_config({'thinkingLevel': level})
                self.events.put(('saved_config', cfg))
            except ApiError:
                pass

        threading.Thread(target=worker, daemon=True).start()

    def _toggle_topmost(self) -> None:
        value = not bool(self.config.get('alwaysOnTop', True))
        self.config['alwaysOnTop'] = value
        save_config(self.paths, self.config)
        self._apply_topmost()
        self._raise_pet_above_board()
        self.board.flash('已置顶' if value else '取消置顶')
        self._refresh_tray()

        def worker() -> None:
            try:
                cfg = self.api.put_config({'alwaysOnTop': value})
                self.events.put(('saved_config', cfg))
            except ApiError:
                pass

        threading.Thread(target=worker, daemon=True).start()

    # ═══════════════════════════════════════════════════
    # 显隐 / 退出
    # ═══════════════════════════════════════════════════

    def hide_pet(self) -> None:
        if self._menu is not None:
            self._menu.close()
        self.root.withdraw()
        try:
            self.board_window.withdraw()
        except Exception:
            pass
        self._refresh_tray()

    def show_pet(self) -> None:
        self.root.deiconify()
        if self.board.open and self._board_h > 1:
            try:
                self.board_window.deiconify()
            except Exception:
                pass
        self._apply_topmost()
        self._apply_window()
        self._focus_board()
        self._refresh_tray()

    def quit(self) -> None:
        if self._closing:
            return
        self._closing = True
        if self._menu is not None:
            try:
                self._menu.close()
            except Exception:
                pass
        try:
            self.chat.cancel()
        except Exception:
            pass
        try:
            self.board.destroy()
        except Exception:
            pass
        try:
            self.proactive.destroy()
        except Exception:
            pass
        try:
            self.board_window.destroy()
        except Exception:
            pass
        if self._tray is not None:
            self._tray.stop()
        self._remember_position()
        try:
            self.root.after(10, self.root.destroy)
        except Exception:
            pass

    # ═══════════════════════════════════════════════════
    # 托盘
    # ═══════════════════════════════════════════════════

    def _start_tray(self) -> None:
        if self.demo:
            return
        image = self._tray_image()
        tray = SystemTray(image, self._tray_action, self._tray_state)
        if tray.available and tray.start():
            self._tray = tray
            self._refresh_tray()

    def _tray_image(self) -> Image.Image:
        base = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
        draw = ImageDraw.Draw(base)
        draw.ellipse((1, 1, 62, 62), fill=(*_rgb(COLOR['board']), 255),
                     outline=(*_rgb(COLOR['board_edge']), 255), width=2)
        if self._sprite is not None:
            face = self._sprite.crop((0, 0, self._sprite.width, int(self._sprite.height * 0.72)))
            face.thumbnail((58, 58), Image.Resampling.LANCZOS)
            mask = Image.new('L', face.size, 0)
            ImageDraw.Draw(mask).ellipse((0, 0, face.width - 1, face.height - 1), fill=255)
            base.paste(face, ((64 - face.width) // 2, 3), mask)
        return base

    def _tray_state(self) -> dict[str, Any]:
        # 只读快照；pystray 的线程不碰任何 Tk 对象
        return dict(self._tray_snapshot)

    def _tray_action(self, action: str) -> None:
        self.events.put(('tray', action))

    def _refresh_tray(self) -> None:
        self._tray_snapshot = {
            'visible': self.root.state() != 'withdrawn',
            'running': self.board.running,
            'topmost': bool(self.config.get('alwaysOnTop', True)),
            'due': len(self._due),
        }
        if self._tray is None:
            return
        status = '正在执行' if self.board.running else ('主应用未连接' if self._notified_offline else '空闲')
        title = f'{APP_TITLE} · {status}'
        if self._due:
            title += f' · {len(self._due)} 个提醒到期'
        self._tray.refresh(title)

    def _handle_tray(self, action: str) -> None:
        if action == 'show':
            self.show_pet()
        elif action == 'toggle_board':
            if self.root.state() == 'withdrawn':
                self.show_pet()
            self.toggle_board()
        elif action == 'open_conversation':
            self.open_current_conversation()
        elif action == 'toggle_topmost':
            self._toggle_topmost()
        elif action == 'quit':
            self.quit()

    # ═══════════════════════════════════════════════════
    # 后台服务
    # ═══════════════════════════════════════════════════

    def _start_services(self) -> None:
        self._start_tray()
        self._keep_topmost()
        if self.demo:
            self._start_demo()
            return
        self._check_connection()
        self._load_models()
        self._load_history('startup')
        self.root.after(900, self._poll_active)
        self.root.after(1000, self._poll_config)
        self.root.after(1200, self._poll_tasks)
        self.root.after(15000, self._poll_health)
        # 主动提醒：等页面稳定后再开始，避免刚启动就弹一条。
        self.root.after(15000, self._poll_proactive)

    def _start_demo(self) -> None:
        """演示模式：不需要主应用，按时序把"空闲 → 执行 → 展开 → 完成"走一遍。

        它同时是界面自检：`--snap` 会在这几个时刻把窗口截下来，
        免得每次改完排版都要靠肉眼盯屏幕。
        """
        self.root.after(900, self.board.open_board)
        self.root.after(2400, self._demo_send)
        self.root.after(4800, lambda: self.board.set_expanded(True))
        self.root.after(6300, lambda: self.board.set_expanded(False))
        if self.snap_dir:
            for delay, name in (
                (2200, '01-idle'),
                (5300, '02-running-expanded'),
                (6900, '03-running-collapsed'),
                (8300, '04-done'),
            ):
                self.root.after(delay, lambda n=name: self.snapshot(n))

    def snapshot(self, name: str) -> None:
        if not self.snap_dir:
            return
        try:
            from PIL import ImageGrab

            os.makedirs(self.snap_dir, exist_ok=True)
            self.root.update_idletasks()
            self.board_window.update_idletasks()
            pad = self.theme.px(22)
            left = self.root.winfo_rootx()
            top = self.root.winfo_rooty()
            right = left + self.root.winfo_width()
            bottom = top + self.root.winfo_height()
            if self.board.open and self._board_h > 1:
                left = min(left, self.board_window.winfo_rootx())
                top = min(top, self.board_window.winfo_rooty())
                right = max(right, self.board_window.winfo_rootx() + self.board_window.winfo_width())
                bottom = max(
                    bottom,
                    self.board_window.winfo_rooty() + self.board_window.winfo_height(),
                )
            ImageGrab.grab((left - pad, top - pad, right + pad, bottom + pad)).save(
                os.path.join(self.snap_dir, f'{name}.png')
            )
        except Exception:
            pass

    def _demo_open(self) -> None:
        self.board.open_board()

    def _demo_send(self) -> None:
        self.board.set_draft(chatmod.DEMO_USER_TEXT)
        self.board.send()

    def _check_connection(self) -> None:
        def worker() -> None:
            ok = self.api.health()
            self.events.put(('health', ok))

        threading.Thread(target=worker, daemon=True).start()

    def _poll_health(self) -> None:
        if self._closing:
            return
        self._check_connection()
        self.root.after(20000, self._poll_health)

    def _poll_config(self) -> None:
        if self._closing:
            return

        def worker() -> None:
            try:
                cfg = self.api.get_config()
            except Exception:
                return
            self.events.put(('config', cfg))

        threading.Thread(target=worker, daemon=True).start()
        self.root.after(2000, self._poll_config)

    def _poll_tasks(self) -> None:
        if self._closing:
            return

        def worker() -> None:
            due = self.api.due_reminders()
            self.events.put(('reminders', due))

        threading.Thread(target=worker, daemon=True).start()
        self.root.after(20000, self._poll_tasks)

    def _poll_active(self) -> None:
        if self._closing:
            return

        def worker() -> None:
            active = self.api.active_turns()
            self.events.put(('active', active))

        threading.Thread(target=worker, daemon=True).start()
        self.root.after(2800, self._poll_active)

    # ── 主动说话：只领取服务端决定好的结果 ──────────────

    def _poll_proactive(self) -> None:
        if self._closing or self.demo:
            return
        # 人物被隐藏或桌板开着时先不领取；这是展示节奏，不是策略判断。
        if self.root.state() == 'withdrawn' or self.proactive.visible or self.board.open:
            self.root.after(15000, self._poll_proactive)
            return

        def worker() -> None:
            try:
                data = self.api.post('/api/pet/proactive/claim', {})
            except Exception:
                return
            if isinstance(data, dict) and data.get('shouldSpeak') is True:
                self.events.put(('proactive', data))

        threading.Thread(target=worker, daemon=True).start()
        self.root.after(60000, self._poll_proactive)

    def _show_proactive(self, raw: Any) -> None:
        if not isinstance(raw, dict):
            return
        text = raw.get('text')
        if not isinstance(text, str) or not text.strip():
            return
        trigger = raw.get('trigger')
        trigger = trigger if isinstance(trigger, str) else 'return'
        persona = self.config.get('persona')
        persona = persona if isinstance(persona, str) else ''
        try:
            self.root.update_idletasks()
            center_x = self._x + self._pet_x + self._pet_w // 2
            pet_top = self._y
            pet_bottom = self._y + self._pet_h
        except Exception:
            return
        self.proactive.show(
            text,
            trigger=trigger,
            persona=persona,
            center_x=center_x,
            pet_top=pet_top,
            pet_bottom=pet_bottom,
            on_action=self._on_proactive_action,
        )

    def _on_proactive_action(self, action: str) -> None:
        def worker() -> None:
            try:
                self.api.post('/api/pet/proactive/feedback', {'action': action})
            except Exception:
                return

        threading.Thread(target=worker, daemon=True).start()
        # mute 会让服务端关闭开关；下一次配置轮询会带回真实状态。
        self.root.after(2000, self._poll_config)

    def _on_active(self, active: Any) -> None:
        if not isinstance(active, list):
            return
        own = self.chat.session_id if hasattr(self, 'chat') else self._session_id
        others = [
            item
            for item in active
            if isinstance(item, dict)
            and isinstance(item.get('sessionId'), str)
            and item.get('sessionId') != own
        ]
        self._web_active = others
        self.board.set_web_active(others[0] if others else None)
        self._refresh_tray()

    def _load_models(self) -> None:
        if self._models_loading:
            return
        self._models_loading = True

        def worker() -> None:
            models = self.api.chat_models()
            self.events.put(('models', models))

        threading.Thread(target=worker, daemon=True).start()

    def _load_history(self, reason: str, *, min_interval: float = 0.0) -> None:
        """异步读取固定会话的完整历史。

        ★ 只在启动 / 会话确定 / 每轮 finished / 打开桌板时调用；
          `_paint_body`、滚动和动画里没有任何网络调用。
        ★ 同一时间只允许一个请求；期间的新触发合并成一次 pending，
          避免 finished 与打开桌板同时打过去。
        """
        if self.demo or self._closing:
            return
        if self._history_loading:
            # 打开桌板只是“顺便刷新”，在途请求已经覆盖它；
            # 但如果手里还没有任何历史（启动时可能正离线），这次打开必须补上。
            # finished / 会话变化更不能被旧请求吞掉。
            if reason in ('finished', 'session', 'pending') or not self._history_loaded:
                self._history_pending = True
            return
        now = time.monotonic()
        if (
            min_interval > 0
            and now - self._history_last_attempt < min_interval
            and self._history_loaded
        ):
            # 只有“刚成功过”才值得跳过；失败后打开桌板应该能立刻重试。
            return
        session_id = self.chat.session_id or self._session_id
        if not isinstance(session_id, str) or not session_id:
            return
        self._history_loading = True
        self._history_last_attempt = now
        self._history_session = session_id

        def worker() -> None:
            messages: list[dict[str, Any]] | None = None
            error = ''
            try:
                messages = self.api.session_messages(session_id)
            except ApiError as err:
                error = str(err)
            except Exception as err:  # noqa: BLE001 —— 历史失败不能拖垮桌板
                error = str(err)
            self.events.put(('history', session_id, messages, error))

        threading.Thread(target=worker, daemon=True).start()

    def _on_history(self, session_id: str, messages: Any, error: str = '') -> None:
        self._history_loading = False
        self._history_last_error = error
        current = self.chat.session_id or self._session_id
        expected = self._history_session
        if session_id == current and session_id == expected and messages is not None:
            # messages 是成功响应（可能为空数组）；失败时保持旧历史不覆盖。
            self.board.set_history(messages)
            self._history_loaded = True
        # 会话变了（或请求失败）：结果作废 / 保留旧历史，等下一次触发重读。
        if self._history_pending:
            self._history_pending = False
            self._load_history('pending')

    # ═══════════════════════════════════════════════════
    # 主线程事件循环
    # ═══════════════════════════════════════════════════

    def _chat_emit(self, kind: str, payload: Any) -> None:
        self.events.put(('chat', kind, payload))

    def _poll(self) -> None:
        if self._closing:
            return
        try:
            while True:
                item = self.events.get_nowait()
                self._handle_event(item)
        except queue.Empty:
            pass
        self.root.after(60, self._poll)

    def _handle_event(self, item: tuple[Any, ...]) -> None:
        kind = item[0]
        if kind == 'chat':
            self._handle_chat(item[1], item[2] if len(item) > 2 else None)
        elif kind == 'health':
            self._on_health(bool(item[1]))
        elif kind == 'config':
            self._on_config(item[1])
        elif kind == 'saved_config':
            self._on_saved_config(item[1])
        elif kind == 'models':
            self._on_models(item[1])
        elif kind == 'reminders':
            self._on_reminders(item[1])
        elif kind == 'active':
            self._on_active(item[1])
        elif kind == 'history':
            self._on_history(
                str(item[1]),
                item[2] if len(item) > 2 else None,
                str(item[3]) if len(item) > 3 else '',
            )
        elif kind == 'session_id':
            self._remember_session(str(item[1]))
        elif kind == 'toast':
            self.board.flash(str(item[1]), str(item[2]) if len(item) > 2 else 'ink')
        elif kind == 'proactive':
            self._show_proactive(item[1])
        elif kind == 'tray':
            self._handle_tray(str(item[1]))

    def _handle_chat(self, kind: str, payload: Any) -> None:
        if kind == 'started':
            return
        if kind == 'user_message':
            data = payload if isinstance(payload, dict) else {}
            message_id = data.get('messageId')
            if isinstance(message_id, str) and message_id:
                self.board.set_user_message_id(message_id)
            return
        if kind == 'stage':
            self.board.set_stage(str(payload))
        elif kind == 'narration':
            data = payload if isinstance(payload, dict) else {}
            self.board.set_narration(str(data.get('text', '')), bool(data.get('done')))
        elif kind == 'reply':
            if isinstance(payload, dict):
                text = payload.get('text')
                message_id = payload.get('messageId')
                self.board.set_reply(
                    str(text) if isinstance(text, str) else '',
                    message_id if isinstance(message_id, str) else None,
                )
            else:
                self.board.set_reply(str(payload))
            self._refresh_tray()
        elif kind == 'reflection':
            data = payload if isinstance(payload, dict) else {}
            self.board.set_reflection(int(data.get('pending', 0)), int(data.get('admitted', 0)))
        elif kind == 'error':
            self.board.set_error(str(payload))
            self._refresh_tray()
        elif kind == 'cancelled':
            self.board.set_cancelled()
            self._refresh_tray()
        elif kind == 'finished':
            data = payload if isinstance(payload, dict) else {}
            self.board.finish(float(data.get('elapsed', 0.0)))
            self._refresh_tray()
            # 新消息此时已经落盘；拉一次历史，下一帧起由历史接管去重。
            self._load_history('finished')

    def _on_health(self, ok: bool) -> None:
        self.board.set_connected(ok)
        if ok:
            if self._notified_offline:
                self._notified_offline = False
                self.board.flash('已连上主应用')
            self._notified_offline = False
            if not self._models_loading and not self._chat_models:
                self._load_models()
            if not self._history_loaded and not self._history_loading:
                # 启动时离线的人，等主应用回来后补读一次；不按帧重试。
                self._load_history('reconnect', min_interval=60.0)
        else:
            self._notified_offline = True
        self._refresh_tray()

    def _on_config(self, raw: Any) -> None:
        cfg = normalize_config(raw)
        old = self.config
        # updatedAt 每次轮询都会变，不能拿它当"用户改了设置"
        changed = {key for key in cfg if key != 'updatedAt' and cfg.get(key) != old.get(key)}
        self.config = cfg
        if not cfg.get('proactiveEnabled', False):
            # 设置页关掉主动说话后，已经弹出的提醒也应该收起。
            try:
                self.proactive.hide()
            except Exception:
                pass
        if changed:
            save_config(self.paths, cfg)
        if 'enabled' in changed:
            if cfg.get('enabled', True):
                if self.root.state() == 'withdrawn':
                    self.show_pet()
            else:
                self.hide_pet()
        if 'alwaysOnTop' in changed:
            self._apply_topmost()
            self._refresh_tray()
        if 'size' in changed or 'sprite' in changed:
            self._load_sprite()
            self._layout_for_pet()

    def _on_saved_config(self, raw: Any) -> None:
        if not isinstance(raw, dict) or not raw:
            return
        self.config = normalize_config(raw)
        save_config(self.paths, self.config)
        self._refresh_tray()

    def _on_models(self, models: Any) -> None:
        self._models_loading = False
        if isinstance(models, list):
            self._chat_models = [m for m in models if isinstance(m, dict)]

    def _on_reminders(self, due: Any) -> None:
        if not isinstance(due, list):
            return
        if len(due) == len(self._due):
            return
        self._due = due
        self._render_pet()
        self._refresh_tray()

    def _remember_session(self, session_id: str) -> None:
        changed = session_id != self._session_id
        self._session_id = session_id
        self.chat.session_id = session_id
        self.chat._session_checked = True
        self.state['sessionId'] = session_id
        save_state(self.paths, self.state)
        if changed:
            # 会话换了就不能继续显示旧会话的历史；新历史读失败时至少不会张冠李戴。
            self._history_loaded = False
            self._history_session = ''
            self._history_last_error = ''
            self.board.set_history([])
        self._load_history('session')

    def _layout_for_pet(self) -> None:
        self._board_w = self._compute_board_w()
        self._window_w = max(self.theme.px(self._board_w), self._pet_w)
        self._pet_x = (self._window_w - self._pet_w) // 2
        self.pet_frame.configure(width=self._window_w, height=self._pet_h)
        self.pet_label.place(x=0, y=0, width=self._window_w, height=self._pet_h)
        self.board.set_board_width(self._board_w)
        self.board.set_window_width(self._window_w)
        self._update_max_board_h()
        self._render_pet()
        self._apply_window()


def _rgb(color: str) -> tuple[int, int, int]:
    value = color.lstrip('#')
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))
