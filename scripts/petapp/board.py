"""桌板 —— 桌宠下方那块米色浮窗。

═══ 这一版只有一块完整的桌板面 ═══

桌板是**独立的 Toplevel**：人物窗口在上、桌板窗口在下。
人物图里的透明像素会真的露出下面那块桌板，因此不再需要
`_board_cap_layer` 那种"把上沿画进人物图"的补丁；桌板从人物手部
那一行开始，四角同半径，全部由同一个 Canvas 画出来。

═══ 界面只保留必要信息 ═══

  idle    只有一个输入框（一颗加号、一颗线性麦克风、一颗向上发送）
  running 输入框收成右上角铅笔胶囊；正文只显示"正在思考ing/正在执行"
          与流式叙述（不显示阶段名、工具名、参数、结果）
  done    只显示最终答复；没有底部元信息、没有问候、没有上次回复

输入框是桌板本身：没有内嵌卡片、没有状态栏、没有"收起"文字。
只有三个动作图标，说明放在 tooltip 里。
"""

from __future__ import annotations

import math
import queue
import re
import threading
import time
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog
from typing import Any, Callable

from . import draw
from .draw import TextWrapper, blend, ellipsize, rounded_points
from .files import (
    IMAGE_KIND,
    MAX_ATTACHMENTS,
    Attachment,
    compose_message,
    load_document,
    load_image,
    make_attachment,
)
from .theme import COLOR, TRANSPARENT, Theme

PLACEHOLDER = '说点什么…'
THINKING_TEXT = '正在思考ing'
EXECUTING_TEXT = '正在执行'
WEB_ACTIVE_TEXT = '主界面有对话正在执行'

BODY_STATES = {'running', 'done', 'error', 'cancelled'}

# 历史里用户消息的“内部文档正文”标记：
#   Web 桌宠：\n\n【附件：name】
#   Tk 桌宠：\n\n【附件 · name】
# 两段正文都属于发出去的上下文，不是用户输入，不上面板。
DOC_MARKER_RE = re.compile(r'\n*【附件\s*[：:·]')


@dataclass(frozen=True)
class HistoryMessage:
    """桌板能看到的、最小化的一条历史消息。"""

    id: str
    role: str
    text: str
    created_at: float = 0.0


@dataclass
class _HistoryBlock:
    """历史消息的折行结果；只在历史或宽度变化时重建。"""

    message: HistoryMessage
    lines: list[str]
    font_key: str
    width: int
    pad: int
    label_h: int
    bubble_h: int
    height: int


def display_user_history_text(text: str) -> str:
    """只显示用户真正输入的内容，去掉随消息发送的文档正文。"""
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    match = DOC_MARKER_RE.search(text)
    if match is not None:
        visible = text[: match.start()].strip()
        # 只发了附件、没有文字：给一个用户能看懂的回退，而不是空白气泡。
        return visible or '（附件）'
    return text.strip()


def normalize_history_messages(raw: Any) -> list[HistoryMessage]:
    """把 `GET /api/sessions/<id>` 的 messages 收窄成桌板要显示的部分。

    ★ 只允许 user / butler；reasoning、agentTrace、verdict 等内部字段
       连读都不读，后续渲染没有机会误用。
    """
    if not isinstance(raw, list):
        return []
    out: list[HistoryMessage] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        role = item.get('role')
        if role not in ('user', 'butler'):
            continue
        text = item.get('text')
        if not isinstance(text, str):
            continue
        display = display_user_history_text(text) if role == 'user' else text.strip()
        if not display:
            # 只发了图片/附件时服务端 user.text 可能是空串；保留这一条，
            # 否则当前轮的用户消息没有 id 可去重，会掉到管家答复后面。
            if role == 'user':
                display = '（附件）'
            else:
                continue
        message_id = item.get('id')
        created_at = item.get('createdAt')
        out.append(
            HistoryMessage(
                id=message_id if isinstance(message_id, str) else '',
                role=role,
                text=display,
                created_at=float(created_at) if isinstance(created_at, (int, float)) else 0.0,
            )
        )
    return out


class Animated:
    """指数趋近的标量。内容高度连续变化时比关键帧稳定。"""

    def __init__(self, value: float = 0.0, tau: float = 0.08) -> None:
        self.value = float(value)
        self.target = float(value)
        self.tau = tau

    def to(self, target: float) -> None:
        self.target = float(target)

    def update(self, dt: float) -> bool:
        diff = self.target - self.value
        if abs(diff) <= 0.4:
            if self.value != self.target:
                self.value = self.target
                return True
            return False
        self.value += diff * (1.0 - math.exp(-dt / self.tau))
        return True

    @property
    def active(self) -> bool:
        return abs(self.target - self.value) > 0.4


class Tooltip:
    """桌板图标的小字说明。Tk 没有原生 tooltip，这里只用一个小 Toplevel。"""

    def __init__(self, root: tk.Misc, theme: Theme) -> None:
        self.root = root
        self.t = theme
        self._job: str | None = None
        self._win: tk.Toplevel | None = None

    def schedule(self, text: str, x: int, y: int) -> None:
        self.hide()
        if not text:
            return
        self._job = self.root.after(380, lambda: self._show(text, x, y))

    def _show(self, text: str, x: int, y: int) -> None:
        self._job = None
        try:
            win = tk.Toplevel(self.root)
            win.overrideredirect(True)
            win.attributes('-topmost', True)
            win.configure(bg=COLOR['ink'])
            label = tk.Label(
                win, text=text, bg=COLOR['ink'], fg='#FFFDF8',
                font=self.t.fonts['tooltip'], padx=self.t.px(8), pady=self.t.px(4),
                bd=0, highlightthickness=0,
            )
            label.pack()
            win.update_idletasks()
            w, h = win.winfo_reqwidth(), win.winfo_reqheight()
            sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
            x = max(6, min(x + self.t.px(10), sw - w - 6))
            y = y + self.t.px(16)
            if y + h > sh - 6:
                y = max(6, y - h - self.t.px(28))
            win.geometry(f'+{x}+{y}')
            self._win = win
        except Exception:
            self._win = None

    def hide(self) -> None:
        if self._job is not None:
            try:
                self.root.after_cancel(self._job)
            except Exception:
                pass
            self._job = None
        if self._win is not None:
            try:
                self._win.destroy()
            except Exception:
                pass
            self._win = None

    def destroy(self) -> None:
        self.hide()


class Toast:
    """临时反馈。浮在桌板下方，不参与布局，不制造第二行状态。"""

    def __init__(self, root: tk.Misc, theme: Theme) -> None:
        self.root = root
        self.t = theme
        self._win: tk.Toplevel | None = None
        self._job: str | None = None

    def show(self, text: str, x: int, y: int, tone: str = 'ink') -> None:
        self.hide()
        bg = {
            'danger': COLOR['danger'],
            'warn': COLOR['warn'],
            'accent': COLOR['accent'],
        }.get(tone, COLOR['ink'])
        try:
            win = tk.Toplevel(self.root)
            win.overrideredirect(True)
            win.attributes('-topmost', True)
            label = tk.Label(
                win, text=text, bg=bg, fg='#FFFDF8', font=self.t.fonts['tooltip'],
                padx=self.t.px(10), pady=self.t.px(5), bd=0, highlightthickness=0,
            )
            label.pack()
            win.update_idletasks()
            w, h = win.winfo_reqwidth(), win.winfo_reqheight()
            sw, sh = win.winfo_screenwidth(), win.winfo_screenheight()
            px = max(6, min(x, sw - w - 6))
            py = y
            if py + h > sh - 6:
                py = max(6, y - h - self.t.px(12))
            win.geometry(f'+{px}+{py}')
            self._win = win
            self._job = self.root.after(2400, self.hide)
        except Exception:
            self._win = None

    def hide(self) -> None:
        if self._job is not None:
            try:
                self.root.after_cancel(self._job)
            except Exception:
                pass
            self._job = None
        if self._win is not None:
            try:
                self._win.destroy()
            except Exception:
                pass
            self._win = None

    def destroy(self) -> None:
        self.hide()


class BoardView:
    def __init__(
        self,
        root: tk.Tk,
        frame: tk.Frame,
        theme: Theme,
        board_w_logical: float,
        api: Any,
        callbacks: dict[str, Callable[..., Any]],
        *,
        demo: bool = False,
    ) -> None:
        self.root = root
        self.frame = frame
        self.toplevel = frame.winfo_toplevel()
        self.t = theme
        self.api = api
        self.cb = callbacks
        self.demo = demo

        self.W = 0
        self._apply_metrics(board_w_logical)

        self.open = False
        self.state = 'idle'
        self.expanded = True
        self.connected = True
        self.stage = ''
        self.narration = ''
        self.narration_done = False
        self.answer = ''
        self.error_text = ''
        self.last_user = ''
        self.last_user_id = ''
        self.answer_id = ''
        self.started_at = 0.0
        self.voice_state = 'idle'
        self.attachments: list[Attachment] = []
        self.web_active: dict[str, Any] | None = None

        # 完整历史（只含 user / butler）与它的折行缓存。
        # 历史只在 set_history 时重建；流式 narration 的每帧只重画 current 层。
        self.history: list[HistoryMessage] = []
        self._history_ids: set[str] = set()
        self._history_sig: tuple[tuple[str, str, str], ...] | None = None
        self._history_version = 0
        self._history_layout: list[_HistoryBlock] | None = None
        self._history_layout_w = -1
        self._history_height = 0
        self._history_paint_key: tuple[int, int] | None = None
        self._scroll_anchor: float | None = None
        # 第一轮结束时历史还是空的：set_reply 为了看长答复先停在顶部；
        # 紧接着的历史刷新第一次把整段对话接上，此时应该回到底部看新答复。
        self._follow_first_history = False

        self.board_h = Animated(0.0, 0.10)
        self.composer_h = Animated(0.0, 0.075)
        self.body_content_h = 0
        self.input_lines = 1
        self._applied_h = -1
        self._anim_job: str | None = None
        self._pulse_job: str | None = None
        self._pulse_phase = 0
        self._last_tick = 0.0
        self._hover: str | None = None
        self._placeholder = False
        self._closed_reported = True
        self._closing = False
        self._dictation: Any = None
        self._events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._body_dots: list[int] = []
        self._top_dots: list[int] = []
        self._voice_ring: int | None = None
        self._scroll_item: int | None = None
        self._scroll_follow = True
        self.wrapper = TextWrapper()

        self.tooltip = Tooltip(root, theme)
        self.toast = Toast(root, theme)

        self._build()
        self._bind()
        self._schedule_threads()
        self._sync_placeholder()

    def _external_idle(self) -> bool:
        """空闲时 Web 另有对话在执行：桌板只留一条跳转提示，不再显示输入框。"""
        return self.state == 'idle' and self.web_active is not None

    # ═══════════════════════════════════════════════════
    # 尺寸
    # ═══════════════════════════════════════════════════

    def _apply_metrics(self, board_w_logical: float) -> None:
        t = self.t
        self.W = t.px(board_w_logical)
        self.pad = t.px(t.pad)
        self.body_pad = t.px(t.body_pad)
        self.radius = t.px(t.radius)
        self.action_h = t.px(t.action_h)
        self.top_row_h = t.px(t.top_row_h)
        self.body_gap = t.px(t.body_gap)
        self.att_chip_h = t.px(t.att_chip_h)
        self.att_gap = t.px(t.att_gap)
        self.max_body_h = t.px(t.max_body_h)
        self.min_board_h = t.px(t.min_board_h)
        self.max_board_h = getattr(self, 'max_board_h', 10_000)
        self.input_line = int(t.fonts['input'].metrics('linespace'))
        self.input_min_lines = 1
        self.input_max_lines = 4
        self.input_lines = max(1, min(4, getattr(self, 'input_lines', 1)))
        old_body_w = getattr(self, 'body_w', -1)
        self.body_w = self.W - 2 * self.body_pad
        if old_body_w != self.body_w:
            # 宽度变了，历史折行必须重排；但只在真正变宽/变窄时做一次。
            self._history_layout = None
            self._history_layout_w = -1
            self._history_paint_key = None
        if hasattr(self, 'body'):
            self.body.configure(yscrollincrement=t.line_h('answer'))
        if hasattr(self, 'chrome') and self.W > 0:
            self._apply_geometry()

    def set_board_width(self, board_w_logical: float) -> None:
        self._apply_metrics(board_w_logical)
        if self.open:
            self._paint_all()
            self._reflow()
            self._apply_geometry()

    def set_window_width(self, width: int) -> None:
        # 新方案里桌板是独立窗口，宽度由 BoardView 自己决定。
        _ = width

    # ═══════════════════════════════════════════════════
    # 构建
    # ═══════════════════════════════════════════════════

    def _build(self) -> None:
        t = self.t
        self.chrome = tk.Canvas(
            self.frame, bg=TRANSPARENT, bd=0, highlightthickness=0, takefocus=0
        )
        self.body = tk.Canvas(
            self.frame, bg=COLOR['board'], bd=0, highlightthickness=0, takefocus=0
        )
        self.body.configure(yscrollincrement=t.line_h('answer'))
        self.input = tk.Text(
            self.frame,
            bg=COLOR['board'],
            fg=COLOR['ink'],
            insertbackground=COLOR['accent'],
            selectbackground=COLOR['accent_soft'],
            selectforeground=COLOR['ink'],
            font=t.fonts['input'],
            bd=0,
            highlightthickness=0,
            relief='flat',
            wrap='word',
            undo=True,
            padx=0,
            pady=0,
            spacing1=0,
            spacing2=0,
            spacing3=0,
            takefocus=1,
        )
        self.chrome.place(x=0, y=0, width=self.W, height=1)
        self.body.place_forget()
        self.input.place_forget()

    def _bind(self) -> None:
        for tag, action in (
            ('file', self.pick_files),
            ('voice', self.toggle_voice),
            ('send', self.send),
            ('stop', lambda: self.cb['on_stop']()),
            ('expand', lambda: self.set_expanded(True, focus=True)),
            ('collapse', lambda: self.set_expanded(False)),
        ):
            self.chrome.tag_bind(tag, '<Button-1>', lambda _e, a=action: a())
            self.chrome.tag_bind(tag, '<Enter>', lambda e, n=tag: self._hover_on(n, e))
            self.chrome.tag_bind(tag, '<Leave>', lambda _e, n=tag: self._hover_off(n))

        for widget in (self.body, self.chrome):
            widget.tag_bind('openconv', '<Button-1>', lambda _e: self._open_web_active())
            widget.tag_bind('openconv', '<Enter>', lambda e: self._hover_on('openconv', e))
            widget.tag_bind('openconv', '<Leave>', lambda _e: self._hover_off('openconv'))

        for index in range(MAX_ATTACHMENTS):
            tag = f'attclose{index}'
            self.chrome.tag_bind(
                tag, '<Button-1>', lambda _e, i=index: self._remove_attachment_at(i)
            )
            self.chrome.tag_bind(tag, '<Enter>', lambda e, n=tag: self._hover_on(n, e))
            self.chrome.tag_bind(tag, '<Leave>', lambda _e, n=tag: self._hover_off(n))

        for widget in (self.chrome, self.body, self.input):
            widget.bind('<Button-3>', self._on_right_click)
        self.chrome.bind('<MouseWheel>', self._on_wheel)
        self.body.bind('<MouseWheel>', self._on_wheel)
        self.body.bind('<Configure>', lambda _e: self._update_scrollbar())

        self.input.bind('<Return>', self._on_return)
        self.input.bind('<Escape>', self._on_input_escape)
        self.input.bind('<FocusOut>', self._on_focus_out)
        self.input.bind('<KeyPress>', self._on_key_press)
        self.input.bind('<KeyRelease>', self._on_key_release)
        self.input.bind('<<Paste>>', self._on_paste)
        self.input.bind('<Button-1>', self._on_input_click, add='+')

    def _schedule_threads(self) -> None:
        self.root.after(90, self._drain_thread_events)

    def _drain_thread_events(self) -> None:
        if self._closing:
            return
        try:
            while True:
                kind, payload = self._events.get_nowait()
                if kind == 'att':
                    att = payload
                    if att.status == 'error':
                        self.flash(f'{att.name} 读取失败', 'danger')
                    self._paint_chrome()
                    self._reflow()
                elif kind == 'voice':
                    self._on_voice_event(payload[0], payload[1] if len(payload) > 1 else None)
        except queue.Empty:
            pass
        self.root.after(90, self._drain_thread_events)

    # ═══════════════════════════════════════════════════
    # 开关
    # ═══════════════════════════════════════════════════

    def open_board(self) -> None:
        if self.open:
            return
        self.open = True
        self._closed_reported = False
        self.board_h.value = 0.0
        self._scroll_follow = True
        self._scroll_anchor = None
        self.cb['on_show']()
        if self.state in ('running', 'done', 'error', 'cancelled') or self._external_idle():
            self.expanded = False
            self.composer_h.value = 0.0
            self.composer_h.to(0)
        else:
            self.expanded = True
            self.composer_h.value = 0.0
            self.composer_h.to(self._composer_full_h())
        self._paint_all()
        self._reflow()
        self._apply_geometry()
        self._start_anim()
        if self.state not in ('running',):
            self.root.after(50, self.focus_input)

    def close_board(self) -> None:
        if not self.open:
            return
        self.open = False
        self.tooltip.hide()
        self.toast.hide()
        self.input.place_forget()
        self._scroll_anchor = None
        self.board_h.to(0)
        self._start_anim()

    def toggle_board(self) -> None:
        if self.open:
            self.close_board()
        else:
            self.open_board()

    def set_expanded(self, expanded: bool, *, focus: bool = False) -> None:
        if self._external_idle():
            return
        expanded = bool(expanded)
        desired = self._composer_full_h() if expanded else 0
        if expanded == self.expanded and abs(self.composer_h.target - desired) < 1:
            if focus:
                self.focus_input()
            return
        self.expanded = expanded
        self.composer_h.to(desired)
        if not expanded:
            # 收起时立刻撤掉真正的 Text 控件；只靠高度动画会让它在
            # 截图/重绘的过渡帧里继续压着状态栏。
            self.input.place_forget()
        self._paint_all()
        self._reflow()
        self._start_anim()
        if expanded and focus:
            self.root.after(30, self.focus_input)
        else:
            self._sync_placeholder()

    def toggle_composer(self) -> None:
        if not self.open:
            self.open_board()
            self.set_expanded(True, focus=True)
            return
        if self.expanded:
            self.set_expanded(False)
        else:
            self.set_expanded(True, focus=True)

    def focus_input(self) -> None:
        if not self.open or self._external_idle():
            return
        if not self.expanded:
            self.set_expanded(True)
        try:
            self.cb['focus_window']()
            self.input.focus_set()
            self.input.mark_set('insert', 'end-1c')
            self.input.see('insert')
        except Exception:
            pass

    def handle_escape(self) -> bool:
        if not self.open:
            return False
        if self.expanded:
            self.set_expanded(False)
        else:
            self.close_board()
        return True

    # ═══════════════════════════════════════════════════
    # 一轮对话
    # ═══════════════════════════════════════════════════

    def begin_run(self, user_text: str) -> None:
        self.state = 'running'
        self.last_user = user_text.strip() if isinstance(user_text, str) else ''
        self.last_user_id = ''
        self.narration = ''
        self.narration_done = False
        self.answer = ''
        self.answer_id = ''
        self.error_text = ''
        self.stage = ''
        self.attachments = []
        self.started_at = time.monotonic()
        self._scroll_follow = True
        self._scroll_anchor = None
        self._follow_first_history = False
        self.expanded = False
        self.composer_h.to(0)
        self.input.place_forget()
        self._sync_placeholder()
        self._paint_all()
        self._reflow()
        self._start_anim()
        self._start_pulse()

    def set_stage(self, label: str) -> None:
        if not label or label == self.stage:
            return
        self.stage = label
        if self.state == 'running':
            self._paint_chrome()
            if self.expanded:
                self._paint_body()
                self._reflow()

    def set_narration(self, text: str, done: bool) -> None:
        if text == self.narration and done == self.narration_done:
            return
        self.narration = text
        self.narration_done = done
        if self.state in ('running',):
            if not self.expanded:
                self._paint_chrome()
            self._paint_body()
            self._reflow()

    def set_reply(self, text: str, message_id: str | None = None) -> None:
        self.answer = self._clean_answer(text, limit=None if self.history else 6000)
        self.answer_id = message_id.strip() if isinstance(message_id, str) else ''
        self.state = 'done'
        self.expanded = False
        self.composer_h.to(0)
        self.input.place_forget()
        # 没有历史时保留旧行为（从答复开头看）；有历史时新答复在底部，
        # 跟随的人留在底部，已经上翻的人保持原位。
        if self.history:
            self._scroll_anchor = None if self._scroll_follow else self._capture_scroll_anchor()
            self._follow_first_history = False
        else:
            self._scroll_follow = False
            self._scroll_anchor = None
            self._follow_first_history = True
        self._sync_placeholder()
        self._paint_all()
        self._reflow()
        if not self.history:
            self.root.after(30, self._scroll_to_top)

    def set_user_message_id(self, message_id: str) -> None:
        """SSE 的 user 事件带 id；拿到后就可以和历史精确去重。"""
        mid = message_id.strip() if isinstance(message_id, str) else ''
        if not mid or mid == self.last_user_id:
            return
        self.last_user_id = mid
        if self.open and self.state in ('running', 'done'):
            self._paint_body()
            self._reflow()

    def set_history(self, messages: Any) -> None:
        """替换完整历史；内容没变时连折行都不重算。"""
        items = normalize_history_messages(messages)
        signature = tuple((item.id, item.role, item.text) for item in items)
        if signature == self._history_sig:
            return
        anchor = None if self._scroll_follow else self._capture_scroll_anchor()
        self.history = items
        self._history_ids = {item.id for item in items if item.id}
        self._history_sig = signature
        self._history_version += 1
        self._history_layout = None
        self._history_paint_key = None
        if self._follow_first_history and items and self.state == 'done':
            # 第一轮答复刚结束，整段历史第一次接上：让新答复留在视野底部。
            self._scroll_follow = True
            self._scroll_anchor = None
            anchor = None
            self._follow_first_history = False
        if not self.open:
            return
        self._paint_body()
        self._reflow()
        self._start_anim()
        if self._scroll_follow:
            self._scroll_anchor = None
        else:
            self._scroll_anchor = anchor
            self._restore_scroll_anchor()

    def set_error(self, message: str) -> None:
        self.state = 'error'
        self.error_text = self._friendly_error(message)
        self.expanded = False
        self.composer_h.to(0)
        self.input.place_forget()
        self._stop_pulse()
        self._sync_placeholder()
        self._paint_all()
        self._reflow()

    def set_cancelled(self) -> None:
        self.state = 'cancelled'
        self.expanded = False
        self.composer_h.to(0)
        self.input.place_forget()
        self._stop_pulse()
        self._sync_placeholder()
        self._paint_all()
        self._reflow()

    def finish(self, elapsed: float) -> None:
        _ = elapsed
        if self.state == 'running':
            self.state = 'error'
            self.error_text = '这一轮没有收到答复。'
            self.expanded = False
            self.composer_h.to(0)
            self.input.place_forget()
            self._sync_placeholder()
            self._paint_all()
            self._reflow()
        self._stop_pulse()

    def set_connected(self, connected: bool) -> None:
        if connected == self.connected:
            return
        self.connected = connected
        self._paint_chrome()
        if self.state in ('error',):
            self._paint_body()
            self._reflow()

    def set_web_active(self, active: dict[str, Any] | None) -> None:
        session = ''
        if isinstance(active, dict):
            raw = active.get('sessionId')
            session = raw if isinstance(raw, str) else ''
        current = ''
        if self.web_active is not None:
            raw = self.web_active.get('sessionId')
            current = raw if isinstance(raw, str) else ''
        if session == current:
            return
        was_external = self._external_idle()
        self.web_active = active if session else None
        if not self.open:
            return
        if self.state == 'idle':
            # 外部执行时输入框收起；外部执行结束后自动恢复输入。
            if self._external_idle():
                self.expanded = False
                self.composer_h.to(0)
                self.input.place_forget()
                self._sync_placeholder()
            elif was_external:
                self.expanded = True
                self.composer_h.value = 0.0
                self.composer_h.to(self._composer_full_h())
                self.root.after(40, self.focus_input)
            self._paint_all()
            self._reflow()
            self._start_anim()
        elif self.state == 'done':
            self._paint_chrome()
            self._paint_body()
            self._reflow()

    def set_reflection(self, pending: int, admitted: int) -> None:
        _ = (pending, admitted)

    def set_reminders(self, count: int) -> None:
        _ = count

    def flash(self, text: str, tone: str = 'ink') -> None:
        if not self.open or not text:
            return
        try:
            x = self.toplevel.winfo_rootx() + self.body_pad
            y = self.toplevel.winfo_rooty() + max(1, int(self.board_h.value)) + self.t.px(6)
            self.toast.show(text, x, y, tone)
        except Exception:
            pass

    @property
    def running(self) -> bool:
        return self.state == 'running'

    @property
    def reminding(self) -> int:
        return 0

    # ═══════════════════════════════════════════════════
    # 画图：桌板面
    # ═══════════════════════════════════════════════════

    def _paint_all(self) -> None:
        self._paint_chrome()
        self._paint_body()

    def _paint_chrome(self) -> None:
        c = self.chrome
        c.delete('all')
        self._top_dots = []
        self._voice_ring = None
        h = max(1, int(round(self.board_h.value)))
        if h < 2:
            return
        r = max(2.0, min(float(self.radius), h / 2 - 1))
        c.create_polygon(
            rounded_points(0, 0, self.W, h, r, r, r, r),
            fill=COLOR['board'], outline='',
        )
        c.create_line(
            self._border_points(h), fill=COLOR['board_edge'],
            width=max(1, self.t.px(0.8)), smooth=False,
        )
        if self._external_idle():
            self._paint_external_prompt(c)
            return
        if not self.expanded and self.state in BODY_STATES:
            self._paint_top_row(c)
        if self.expanded and self.composer_h.value > 2:
            self._paint_composer(c)
            if self.state in BODY_STATES:
                self._paint_collapse(c)

    def _border_points(self, h: int) -> list[float]:
        """左右、底部与四个角的描边；不描上沿正中，避免和手部之间出现横线。"""
        r = max(2.0, min(float(self.radius), h / 2 - 1))
        pts: list[float] = []
        # 左上弧：从顶边 270° 到左边 180°
        for i in range(9):
            a = math.radians(270 - 90 * (i / 8))
            pts.extend([r + math.cos(a) * r, r + math.sin(a) * r])
        pts.extend([0.5, h - r])
        # 左下弧：左边中点 → 底边中点（屏幕坐标里角度 180 → 90）
        for i in range(9):
            a = math.radians(180 - 90 * (i / 8))
            pts.extend([r + math.cos(a) * r, h - r + math.sin(a) * r])
        pts.extend([self.W - r, h - 0.5])
        # 右下弧：底边中点 → 右边中点（角度 90 → 0）
        for i in range(9):
            a = math.radians(90 - 90 * (i / 8))
            pts.extend([self.W - r + math.cos(a) * r, h - r + math.sin(a) * r])
        pts.extend([self.W - 0.5, r])
        # 右上弧：从右边 360° 回到顶边 270°
        for i in range(9):
            a = math.radians(360 - 90 * (i / 8))
            pts.extend([self.W - r + math.cos(a) * r, r + math.sin(a) * r])
        return pts

    def _paint_external_prompt(self, c: tk.Canvas) -> None:
        t = self.t
        h = t.px(34)
        y = self.pad + t.px(7)
        w = self.W - 2 * self.body_pad
        hover = self._hover == 'openconv'
        c.create_polygon(
            rounded_points(
                self.body_pad, y, self.body_pad + w, y + h,
                t.px(10), t.px(10), t.px(10), t.px(10),
            ),
            fill=COLOR['accent_soft'] if not hover else COLOR['hover'],
            outline='', tags=('openconv',),
        )
        c.create_text(
            self.body_pad + t.px(12), y + h / 2,
            text=WEB_ACTIVE_TEXT, anchor='w', font=t.fonts['status'],
            fill=COLOR['accent_ink'], tags=('openconv',),
        )
        draw.icon_arrow(
            c, self.body_pad + w - t.px(16), y + h / 2, t.px(10),
            COLOR['accent'], width=t.px(1.3), tag='openconv',
        )

    def _paint_top_row(self, c: tk.Canvas) -> None:
        t = self.t
        top = self.pad
        cy = top + self.top_row_h / 2
        cap = self.top_row_h
        cap_x = self.W - self.body_pad - cap
        right = cap_x

        if self.running:
            stop_d = t.px(26)
            stop_x = cap_x - t.px(6) - stop_d
            right = stop_x - t.px(8)
            hover = self._hover == 'stop'
            c.create_oval(
                stop_x, cy - stop_d / 2, stop_x + stop_d, cy + stop_d / 2,
                fill=COLOR['danger_soft'] if hover else COLOR['board_soft'],
                outline='', tags=('stop',),
            )
            draw.icon_stop(c, stop_x + stop_d / 2, cy, t.px(13), COLOR['danger'], tag='stop')

        if self.running:
            text = EXECUTING_TEXT if (self.narration or self.stage) else THINKING_TEXT
            font = t.fonts['status']
            max_w = max(t.px(60), int(right - self.body_pad - t.px(8)))
            text = ellipsize(font, text, max_w)
            c.create_text(
                self.body_pad, cy, text=text, anchor='w', font=font,
                fill=COLOR['ink_3'], tags=('status',),
            )
            dot_x = self.body_pad + font.measure(text) + t.px(7)
            self._draw_pulse_dots(c, dot_x, cy, target='top')

        hover = self._hover == 'expand'
        c.create_oval(
            cap_x, cy - cap / 2, cap_x + cap, cy + cap / 2,
            fill=COLOR['hover'] if hover else COLOR['board_soft'],
            outline='', tags=('expand',),
        )
        draw.icon_pencil(
            c, cap_x + cap / 2, cy, t.px(13),
            COLOR['accent_ink'] if hover else COLOR['ink_3'],
            width=t.px(1.3), tag='expand',
        )

    def _paint_collapse(self, c: tk.Canvas) -> None:
        t = self.t
        d = self.top_row_h
        x = self.W - self.body_pad - d
        cy = self.pad + d / 2
        hover = self._hover == 'collapse'
        c.create_oval(
            x, cy - d / 2, x + d, cy + d / 2,
            fill=COLOR['hover'] if hover else COLOR['board_soft'],
            outline='', tags=('collapse',),
        )
        draw.icon_chevron(
            c, x + d / 2, cy, t.px(11), COLOR['ink_3'],
            up=False, width=t.px(1.4), tag='collapse',
        )

    def _paint_composer(self, c: tk.Canvas) -> None:
        t = self.t
        h = int(round(self.composer_h.value))
        if h < 4:
            return
        att_h = self._attachments_h()
        if att_h and h > att_h + t.px(22):
            self._paint_attachments(
                c, self.body_pad, self.pad, self.W - 2 * self.body_pad
            )
        if h < self.action_h + 6:
            return
        actions_y = self.pad + h - self.action_h
        self._paint_actions(c, actions_y)

    def _paint_actions(self, c: tk.Canvas, y: int) -> None:
        t = self.t
        r = self.action_h / 2
        cy = y + r
        x0 = self.body_pad + r
        gap = t.px(36)

        self._hit_circle(c, 'file', x0, cy, r)
        draw.icon_plus(
            c, x0, cy, t.px(14), COLOR['ink_2'],
            width=t.px(1.6), tag='file',
        )

        mx = x0 + gap
        listening = self.voice_state == 'listening'
        self._hit_circle(
            c, 'voice', mx, cy, r,
            fill=COLOR['accent_soft'] if listening or self._hover == 'voice' else COLOR['board'],
        )
        if listening:
            self._voice_ring = c.create_oval(
                mx - r, cy - r, mx + r, cy + r,
                outline=COLOR['accent_line'], width=t.px(2), tags=('voice',),
            )
        draw.icon_mic(
            c, mx, cy, t.px(16),
            COLOR['accent_ink'] if listening else COLOR['ink_2'],
            width=t.px(1.5), tag='voice',
        )

        sx = self.W - self.body_pad - r
        if self.running:
            hover = self._hover == 'stop'
            c.create_oval(
                sx - r, cy - r, sx + r, cy + r,
                fill=COLOR['danger_soft'] if hover else COLOR['board_soft'],
                outline='', tags=('stop',),
            )
            draw.icon_stop(c, sx, cy, t.px(13), COLOR['danger'], tag='stop')
            return

        enabled = self._send_enabled()
        hover = self._hover == 'send'
        if not enabled:
            fill = COLOR['board_soft']
            ink = COLOR['ink_4']
        elif hover:
            fill = COLOR['accent_ink']
            ink = '#FFFDF8'
        else:
            fill = COLOR['accent']
            ink = '#FFFDF8'
        c.create_oval(
            sx - r, cy - r, sx + r, cy + r,
            fill=fill, outline='', tags=('send',),
        )
        draw.icon_arrow_up(c, sx, cy, t.px(15), ink, width=t.px(1.7), tag='send')

    def _hit_circle(
        self, c: tk.Canvas, tag: str, cx: float, cy: float, r: float,
        *,
        fill: str | None = None,
    ) -> None:
        hover = self._hover == tag
        if fill is None:
            fill = COLOR['hover'] if hover else COLOR['board']
        c.create_oval(
            cx - r, cy - r, cx + r, cy + r,
            fill=fill, outline='', tags=(tag,),
        )

    def _draw_pulse_dots(
        self, c: tk.Canvas, x: float, cy: float, *, target: str = 'body'
    ) -> None:
        t = self.t
        r = t.px(1.7)
        for index in range(3):
            item = c.create_oval(
                x + index * t.px(7) - r, cy - r,
                x + index * t.px(7) + r, cy + r,
                fill=COLOR['accent_soft'], outline='',
                tags=('dot',) if target == 'top' else ('dot', 'current'),
            )
            if target == 'top':
                self._top_dots.append(item)
            else:
                self._body_dots.append(item)

    def _paint_attachments(self, c: tk.Canvas, x: float, y: float, w: float) -> None:
        t = self.t
        font = t.fonts['chip']
        cx = x
        shown = 0
        total = len(self.attachments)
        for index, att in enumerate(self.attachments):
            avail = (x + w) - cx
            if avail < t.px(76):
                break
            if att.status == 'loading':
                detail = '读取中…'
            elif att.status == 'error':
                detail = '读取失败'
            else:
                detail = att.detail
            text = f'{att.name} · {detail}' if detail else att.name
            chip_w = min(t.px(220), max(t.px(76), font.measure(text) + t.px(34)), avail)
            chip_h = self.att_chip_h
            fill = COLOR['danger_soft'] if att.status == 'error' else COLOR['board_soft']
            c.create_polygon(
                rounded_points(cx, y, cx + chip_w, y + chip_h, t.px(8), t.px(8),
                               t.px(8), t.px(8)),
                fill=fill, outline='', tags=('att',),
            )
            draw.icon_file(
                c, cx + t.px(8), y + chip_h / 2, t.px(10),
                COLOR['danger'] if att.status == 'error' else COLOR['ink_3'],
                width=t.px(1.0), tag='att',
            )
            c.create_text(
                cx + t.px(16), y + chip_h / 2,
                text=ellipsize(font, text, int(chip_w - t.px(32))),
                anchor='w', font=font,
                fill=COLOR['danger'] if att.status == 'error' else COLOR['ink_2'],
                tags=('att',),
            )
            close_x = cx + chip_w - t.px(12)
            hit_tag = f'attclose{index}'
            c.create_rectangle(
                close_x - t.px(8), y + 2, close_x + t.px(8), y + chip_h - 2,
                fill=fill, outline='', tags=(hit_tag,),
            )
            draw.icon_close(
                c, close_x, y + chip_h / 2, t.px(10), COLOR['ink_4'],
                width=t.px(1.0), tag=hit_tag,
            )
            cx += chip_w + self.att_gap
            shown += 1
        if shown < total:
            c.create_text(
                cx + t.px(2), y + self.att_chip_h / 2, text=f'+{total - shown}',
                anchor='w', font=font, fill=COLOR['ink_4'],
            )

    # ═══════════════════════════════════════════════════
    # 画图：正文
    # ═══════════════════════════════════════════════════

    def _paint_body(self) -> None:
        c = self.body
        self._body_dots = []
        if not self._body_has_content():
            c.delete('all')
            self._scroll_item = None
            self.body_content_h = 0
            self._history_paint_key = None
            c.configure(scrollregion=(0, 0, self.body_w, 1))
            self._update_scrollbar()
            return

        text_w = max(20, self.body_w - 6)
        key = (self._history_version, self.body_w)
        full = key != self._history_paint_key
        anchor = None
        if not self._scroll_follow:
            anchor = self._capture_scroll_anchor()

        try:
            if full:
                # 历史变了或宽度变了：整页重建一次，之后流式只动 current 层。
                c.delete('all')
                self._scroll_item = None
                self._history_paint_key = key
                y = self._paint_history(c)
            else:
                c.delete('current')
                y = self._history_height

            y = self._paint_current(c, y, text_w)
            self.body_content_h = int(max(0, y) + 2)
            c.configure(scrollregion=(0, 0, self.body_w, max(self.body_content_h, 1)))
            if self._scroll_follow:
                self._scroll_anchor = None
                c.yview_moveto(1.0)
            elif anchor is not None:
                self._scroll_anchor = anchor
                self._restore_scroll_anchor()
            self._update_scrollbar()
        except Exception:
            self.error_text = '界面渲染出错'
            c.delete('all')
            self._scroll_item = None
            self._body_dots = []
            self._history_paint_key = None
            c.create_text(
                0, 0, text='界面渲染出错', anchor='nw',
                font=self.t.fonts['hint'], fill=COLOR['danger'],
                tags=('current',),
            )
            self.body_content_h = int(self.t.line_h('hint') + 2)
            c.configure(scrollregion=(0, 0, self.body_w, max(self.body_content_h, 1)))
            if self._scroll_follow:
                c.yview_moveto(1.0)

    def _body_has_content(self) -> bool:
        # 主界面有别的对话在执行时，桌板只保留那条跳转提示（旧行为）。
        if self._external_idle():
            return False
        return bool(self.history) or self.state in BODY_STATES

    def _paint_history(self, c: tk.Canvas) -> float:
        self._ensure_history_layout()
        y = 0.0
        for block in self._history_layout or []:
            self._draw_block(c, block, y, 'hist')
            y += block.height
        self._history_height = y
        return y

    def _ensure_history_layout(self) -> None:
        width = max(20, self.body_w - 6)
        if self._history_layout is not None and self._history_layout_w == width:
            return
        blocks: list[_HistoryBlock] = []
        for message in self.history:
            if message.role == 'user':
                blocks.append(self._make_block(message, 'user', message.text, width))
                continue
            # 管家正文沿用现有的轻量 Markdown 清理，但历史不设 6000 字上限。
            text = self._clean_answer(message.text, limit=None)
            if text:
                blocks.append(self._make_block(message, 'butler', text, width))
        self._history_layout = blocks
        self._history_layout_w = width

    def _make_block(
        self, message: HistoryMessage, role: str, text: str, width: int
    ) -> _HistoryBlock:
        t = self.t
        label_h = t.line_h('meta')
        if role == 'user':
            font_key = 'quote'
            pad = t.px(8)
            text_w = max(10, width - 2 * pad)
            lines = self.wrapper.lines(t.fonts[font_key], text, text_w)
            text_h = len(lines) * t.line_h(font_key)
            bubble_h = max(t.line_h(font_key) + 2 * pad, text_h + 2 * pad)
        else:
            font_key = 'answer'
            pad = 0
            lines = self.wrapper.lines(t.fonts[font_key], text, width)
            bubble_h = len(lines) * t.line_h(font_key)
        return _HistoryBlock(
            message=message,
            lines=lines,
            font_key=font_key,
            width=width,
            pad=pad,
            label_h=label_h,
            bubble_h=bubble_h,
            height=label_h + t.px(3) + bubble_h + t.px(12),
        )

    def _draw_block(
        self, c: tk.Canvas, block: _HistoryBlock, y: float, tag: str
    ) -> None:
        t = self.t
        user = block.message.role == 'user'
        c.create_text(
            0, y, text='你' if user else '管家', anchor='nw', font=t.fonts['meta'],
            fill=COLOR['accent_ink'] if user else COLOR['ink_3'], tags=(tag,),
        )
        text_y = y + block.label_h + t.px(3)
        if user:
            radius = min(float(t.px(8)), block.bubble_h / 2)
            c.create_polygon(
                rounded_points(
                    0, text_y, block.width, text_y + block.bubble_h,
                    radius, radius, radius, radius,
                ),
                fill=COLOR['board_soft'], outline='', tags=(tag,),
            )
            self._draw_lines(
                c, block.pad, text_y + block.pad, block.lines,
                block.font_key, COLOR['ink_2'], tag,
            )
        else:
            self._draw_lines(
                c, 0, text_y, block.lines, block.font_key, COLOR['ink'], tag
            )

    def _paint_current(self, c: tk.Canvas, y: float, text_w: int) -> float:
        if self.state not in BODY_STATES:
            return y
        t = self.t
        user_text = self._current_user_text()
        answer_text = self._current_answer_text() if self.state == 'done' else ''
        has_status = self.state == 'running' and self.expanded
        has_narration = self.state == 'running' and bool(self.narration)
        has_error = self.state == 'error' and bool(self.error_text)
        has_cancelled = self.state == 'cancelled'
        # 首轮没有历史时保持旧观感：只显示状态/叙述/答复，不额外画"你"。
        show_user = bool(self.history and user_text)
        if not (
            show_user or answer_text or has_status or has_narration
            or has_error or has_cancelled
        ):
            return y

        if self.history:
            y += t.px(8)
            c.create_line(
                0, y, max(1, self.body_w - 6), y,
                fill=COLOR['divider'], width=max(1, t.px(0.8)), tags=('current',),
            )
            y += t.px(8)

        if show_user:
            message = HistoryMessage(id=self.last_user_id, role='user', text=user_text)
            block = self._make_block(message, 'user', user_text, text_w)
            self._draw_block(c, block, y, 'current')
            y += block.height

        if self.state == 'running':
            if self.expanded:
                y = self._draw_status(c, y)
            if self.narration:
                y = self._lines(
                    c, 0, y + t.px(1), self.narration, 'quote',
                    COLOR['ink_2'], text_w, tag='current',
                )
                y += t.px(2)
        elif self.state == 'done' and answer_text:
            if self.history:
                c.create_text(
                    0, y, text='管家', anchor='nw', font=t.fonts['meta'],
                    fill=COLOR['ink_3'], tags=('current',),
                )
                y += t.line_h('meta') + t.px(3)
            y = self._lines(
                c, 0, y, answer_text, 'answer', COLOR['ink'], text_w,
                tag='current',
            )
            y += t.px(2)
        elif self.state == 'error':
            y = self._lines(
                c, 0, y, self.error_text, 'answer', COLOR['ink_2'], text_w,
                tag='current',
            )
            y += t.px(2)
        elif self.state == 'cancelled':
            c.create_text(
                0, y, text='已停止', anchor='nw', font=t.fonts['status'],
                fill=COLOR['ink_3'], tags=('current',),
            )
            y += t.line_h('status') + t.px(2)
        return y

    def _current_user_text(self) -> str:
        text = self.last_user.strip() if isinstance(self.last_user, str) else ''
        if not text:
            return ''
        # 拿到 SSE 的 message id 后，用 id 精确判断，避免同文误伤。
        if self.last_user_id:
            return '' if self.last_user_id in self._history_ids else text
        last_user = ''
        for message in reversed(self.history):
            if message.role == 'user':
                last_user = message.text
                break
        if last_user and self._same_text(last_user, text):
            return ''
        return text

    def _current_answer_text(self) -> str:
        answer = self.answer.strip()
        if not answer:
            return ''
        if self.answer_id:
            return '' if self.answer_id in self._history_ids else answer
        for message in reversed(self.history):
            if message.role != 'butler':
                continue
            history_answer = self._clean_answer(message.text, limit=None)
            if history_answer and self._same_text(history_answer, answer):
                return ''
            break
        return answer

    @staticmethod
    def _same_text(left: str, right: str) -> bool:
        return ' '.join(left.split()) == ' '.join(right.split())

    def _draw_status(self, c: tk.Canvas, y: float) -> float:
        t = self.t
        font = t.fonts['status']
        text = EXECUTING_TEXT if (self.narration or self.stage) else THINKING_TEXT
        c.create_text(
            0, y, text=text, anchor='nw', font=font, fill=COLOR['ink_3'],
            tags=('status', 'current'),
        )
        dot_x = font.measure(text) + t.px(8)
        line_h = t.line_h('status')
        self._draw_pulse_dots(c, dot_x, y + line_h / 2, target='body')
        return y + line_h + t.px(4)

    def _lines(
        self,
        c: tk.Canvas,
        x: float,
        y: float,
        text: str,
        font_key: str,
        fill: str,
        width: int,
        *,
        tag: str | None = None,
    ) -> int:
        font = self.t.fonts[font_key]
        return self._draw_lines(
            c, x, y, self.wrapper.lines(font, text, width),
            font_key, fill, tag or '',
        )

    def _draw_lines(
        self,
        c: tk.Canvas,
        x: float,
        y: float,
        lines: list[str],
        font_key: str,
        fill: str,
        tag: str,
    ) -> int:
        font = self.t.fonts[font_key]
        line_h = self.t.line_h(font_key)
        for line in lines:
            if line:
                c.create_text(
                    x, y, text=line, anchor='nw', font=font, fill=fill,
                    tags=(tag,) if tag else (),
                )
            y += line_h
        return y

    def _capture_scroll_anchor(self) -> float | None:
        try:
            if self.body_content_h > 0 and self.body.winfo_height() > 1:
                return float(self.body.canvasy(0))
        except Exception:
            pass
        return None

    def _restore_scroll_anchor(self) -> None:
        anchor = self._scroll_anchor
        if anchor is None:
            return
        try:
            total = max(1, self.body_content_h)
            self.body.yview_moveto(max(0.0, min(1.0, anchor / total)))
        except Exception:
            pass

    def _scroll_to_top(self) -> None:
        try:
            self.body.yview_moveto(0.0)
            self._update_scrollbar()
        except Exception:
            pass

    def _update_scrollbar(self) -> None:
        if self._scroll_item is not None:
            try:
                self.body.delete(self._scroll_item)
            except Exception:
                pass
            self._scroll_item = None
        try:
            view = self.body.winfo_height()
        except Exception:
            return
        if view <= 4 or self.body_content_h <= view + 4:
            return
        first, last = self.body.yview()
        top = self.body.canvasy(0)
        y1 = top + first * view + 2
        y2 = top + last * view - 2
        if y2 - y1 < 14:
            y2 = y1 + 14
        x = self.body_w - 3
        self._scroll_item = self.body.create_line(
            x, y1, x, y2, fill=COLOR['ink_4'],
            width=max(2, self.t.px(2)), capstyle='round',
        )

    # ═══════════════════════════════════════════════════
    # 布局 / 动画
    # ═══════════════════════════════════════════════════

    def _attachments_h(self) -> int:
        return self.att_chip_h + self.att_gap if self.attachments else 0

    def _input_text_h(self) -> int:
        return self.input_lines * self.input_line + self.t.px(2)

    def _composer_full_h(self) -> int:
        return (
            self._attachments_h()
            + self._input_text_h()
            + self.body_gap
            + self.action_h
        )

    def _collapse_visible(self) -> bool:
        return self.expanded and self.state in BODY_STATES

    def _send_enabled(self) -> bool:
        if self.running or not self.connected:
            return False
        if any(a.status == 'loading' for a in self.attachments):
            return False
        return bool(self._input_text() or any(a.ready for a in self.attachments))

    def _body_view_h(self) -> int:
        if not self._body_has_content():
            return 0
        content = max(0, min(self.body_content_h, self.max_body_h))
        if (
            self.state == 'running'
            and not self.expanded
            and not self.narration
            and not self.history
        ):
            return 0
        return content

    def _body_top(self, composer_h: float | None = None) -> int:
        ch = self.composer_h.value if composer_h is None else composer_h
        if self.expanded and ch > 2:
            return int(round(self.pad + ch + self.body_gap))
        if self.state in BODY_STATES or self.history:
            return self.pad + self.top_row_h + self.body_gap
        return self.pad

    def _target_height(self) -> int:
        if not self.open:
            return 0
        body_h = self._body_view_h()
        if self.expanded:
            target = self.pad + self._composer_full_h() + self.pad
            if body_h > 0:
                target += self.body_gap + body_h
        else:
            target = self.pad + self.top_row_h + self.pad
            if body_h > 0:
                target += self.body_gap + body_h
        target = max(target, self.min_board_h)
        return int(min(target, self.max_board_h))

    def _reflow(self) -> None:
        if not self.open:
            self.board_h.to(0)
            self._start_anim()
            return
        self.board_h.to(self._target_height())
        self._start_anim()

    def _start_anim(self) -> None:
        if self._closing:
            return
        if self._anim_job is None:
            self._last_tick = time.monotonic()
            self._anim_job = self.root.after(16, self._tick)

    def _tick(self) -> None:
        self._anim_job = None
        if self._closing:
            return
        now = time.monotonic()
        dt = max(0.001, min(0.06, now - self._last_tick))
        self._last_tick = now
        board_changed = self.board_h.update(dt)
        composer_changed = self.composer_h.update(dt)
        if board_changed or composer_changed:
            self._apply_geometry()
            self._paint_chrome()
            self._update_scrollbar()
        if self.board_h.active or self.composer_h.active:
            self._anim_job = self.root.after(16, self._tick)
        else:
            self._apply_geometry()
            self._paint_chrome()
            if not self.open and not self._closed_reported:
                self._closed_reported = True
                try:
                    self.cb['on_hide']()
                except Exception:
                    pass

    def _apply_geometry(self) -> None:
        h = max(1, int(round(self.board_h.value)))
        if h != self._applied_h:
            self._applied_h = h
            try:
                self.cb['on_height'](h)
            except Exception:
                pass
        self.chrome.place(x=0, y=0, width=self.W, height=max(1, h))
        body_top = self._body_top()
        body_h = max(1, h - body_top - self.pad)
        if self._body_has_content() and self.open and h > body_top + 2:
            self.body.place(
                x=self.body_pad, y=body_top,
                width=max(20, self.body_w), height=body_h,
            )
        else:
            self.body.place_forget()
        self._place_input()
        # 打开桌板/动画变高时优先停在最新一条；用户上翻后这里只用锚点还原。
        if self._body_has_content():
            if self._scroll_follow:
                self.body.yview_moveto(1.0)
            elif self._scroll_anchor is not None:
                self._restore_scroll_anchor()

    def _place_input(self) -> None:
        t = self.t
        h = self.composer_h.value
        if not self.expanded or not self.open or h < t.px(24):
            self.input.place_forget()
            return
        att_h = self._attachments_h()
        if h < att_h + self.action_h + t.px(8):
            self.input.place_forget()
            return
        text_w = self.W - 2 * self.body_pad
        if self._collapse_visible():
            text_w -= t.px(26)
        text_h = max(
            t.px(16),
            int(h) - att_h - self.body_gap - self.action_h,
        )
        self.input.place(
            x=self.body_pad,
            y=self.pad + att_h,
            width=max(20, text_w),
            height=text_h,
        )

    # ═══════════════════════════════════════════════════
    # 交互
    # ═══════════════════════════════════════════════════

    def _tooltip_text(self, tag: str) -> str:
        if tag == 'file':
            return '添加文件'
        if tag == 'voice':
            if self.voice_state == 'listening':
                return '停止语音输入'
            return '语音输入' if not self.running else '执行中不可录音'
        if tag == 'send':
            if self.running:
                return '执行中不可发送'
            if not self.connected:
                return '主应用未连接'
            if not self._send_enabled():
                return '说点什么再发送'
            return '发送'
        if tag == 'stop':
            return '停止这一轮'
        if tag == 'expand':
            return '展开输入框'
        if tag == 'collapse':
            return '收起输入框'
        if tag == 'openconv':
            return '打开主界面正在执行的对话'
        if tag.startswith('attclose'):
            return '移除附件'
        return ''

    def _hover_on(self, tag: str, event: tk.Event) -> None:
        if self._hover == tag:
            return
        self._hover = tag
        try:
            self.chrome.configure(cursor='hand2')
        except Exception:
            pass
        self.tooltip.schedule(
            self._tooltip_text(tag),
            int(getattr(event, 'x_root', 0)),
            int(getattr(event, 'y_root', 0)),
        )
        if tag == 'openconv' and not self._external_idle():
            self._paint_body()
        else:
            self._paint_chrome()

    def _hover_off(self, tag: str) -> None:
        if self._hover != tag:
            return
        self._hover = None
        self.tooltip.hide()
        try:
            self.chrome.configure(cursor='')
        except Exception:
            pass
        if tag == 'openconv' and not self._external_idle():
            self._paint_body()
        else:
            self._paint_chrome()

    def _on_right_click(self, event: tk.Event) -> str:
        self.tooltip.hide()
        self.cb['on_context_menu'](event)
        return 'break'

    def _on_input_click(self, _event: tk.Event) -> None:
        if self._placeholder:
            self._hide_placeholder()
        # 点击 Text 本身已经让这个窗口进入前台；再 focus_force 顶层窗口会
        # 把键盘焦点从 Text 抢回 Toplevel，导致第一个字永远打不进去。
        self.input.focus_set()
        self.input.mark_set('insert', 'end-1c')

    def _on_wheel(self, event: tk.Event) -> None:
        if not self._body_has_content():
            return
        if self.body_content_h <= self.body.winfo_height():
            return
        delta = -1 if event.delta > 0 else 1
        self.body.yview_scroll(delta, 'units')
        if event.delta > 0:
            # 用户主动上翻后，新的 narration / 历史刷新不再把视野拽回底部。
            self._scroll_follow = False
            self._scroll_anchor = None
            self._follow_first_history = False
        else:
            try:
                _first, last = self.body.yview()
                if last >= 0.999:
                    self._scroll_follow = True
                    self._scroll_anchor = None
            except Exception:
                pass
        self._update_scrollbar()

    def _on_return(self, event: tk.Event) -> str:
        if int(getattr(event, 'state', 0)) & 0x1:
            if self._placeholder:
                self._hide_placeholder()
            self.input.insert('insert', '\n')
            self._autosize_input()
            return 'break'
        self.send()
        return 'break'

    def _on_input_escape(self, _event: tk.Event) -> str:
        self.handle_escape()
        return 'break'

    def _on_key_press(self, event: tk.Event) -> str | None:
        if not self._placeholder:
            return None
        if event.char and event.char.isprintable() and not (event.state & 0x4):
            self._hide_placeholder()
            return None
        if event.keysym in ('BackSpace', 'Delete'):
            self._hide_placeholder()
            return 'break'
        if event.keysym in ('Left', 'Right', 'Up', 'Down', 'Home', 'End'):
            self._hide_placeholder()
        return None

    def _on_paste(self, _event: tk.Event) -> None:
        if self._placeholder:
            self._hide_placeholder()

    def _on_key_release(self, _event: tk.Event) -> None:
        if self._placeholder:
            return
        self._autosize_input()

    def _on_focus_out(self, _event: tk.Event) -> None:
        self._sync_placeholder()

    def _autosize_input(self) -> None:
        lines = self._input_lines_now()
        if lines == self.input_lines:
            return
        self.input_lines = lines
        if self.expanded and self.open:
            self.composer_h.to(self._composer_full_h())
            self._reflow()
            self._paint_chrome()
            self._start_anim()

    def _input_lines_now(self) -> int:
        try:
            self.input.update_idletasks()
            count = self.input.count('1.0', 'end-1c', 'displaylines')
            if isinstance(count, tuple):
                count = count[0] if count else 1
            n = int(count) if count else 1
        except Exception:
            n = self.input.get('1.0', 'end-1c').count('\n') + 1
        return max(self.input_min_lines, min(self.input_max_lines, n))

    # ── 占位符 ──────────────────────────────────────

    def _placeholder_text(self) -> str:
        return PLACEHOLDER

    def _show_placeholder(self) -> None:
        self._placeholder = True
        self.input.delete('1.0', 'end')
        self.input.insert('1.0', self._placeholder_text())
        self.input.configure(fg=COLOR['ink_4'])

    def _hide_placeholder(self) -> None:
        self._placeholder = False
        self.input.delete('1.0', 'end')
        self.input.configure(fg=COLOR['ink'])

    def _sync_placeholder(self) -> None:
        if not self._placeholder and self._input_text():
            return
        if self._placeholder and self.input.get('1.0', 'end-1c') == self._placeholder_text():
            return
        self._show_placeholder()

    def _input_text(self) -> str:
        if self._placeholder:
            return ''
        try:
            return self.input.get('1.0', 'end-1c').strip()
        except Exception:
            return ''

    def _clear_input(self) -> None:
        self.input.delete('1.0', 'end')
        self.input_lines = 1
        self._placeholder = False
        self.input.configure(fg=COLOR['ink'])

    def set_draft(self, text: str) -> None:
        if self._placeholder:
            self._hide_placeholder()
        self.input.delete('1.0', 'end')
        self.input.insert('1.0', text)
        self.input_lines = 1
        self._autosize_input()
        if self.open:
            self.set_expanded(True, focus=True)

    # ── 附件 ────────────────────────────────────────

    def pick_files(self) -> None:
        if self.running:
            self.flash('这一轮结束后再加文件', 'warn')
            return
        paths = filedialog.askopenfilenames(
            parent=self.root,
            title='选择要一起发过去的文件',
            filetypes=[
                (
                    '支持的文件',
                    '*.png *.jpg *.jpeg *.gif *.webp *.pdf *.docx *.xlsx *.csv *.txt *.md *.json',
                ),
                ('所有文件', '*.*'),
            ],
        )
        if not paths:
            return
        self.add_files([Path(p) for p in paths])

    def add_files(self, paths: list[Path]) -> None:
        added = 0
        for path in paths:
            if len(self.attachments) >= MAX_ATTACHMENTS:
                self.flash(f'一次最多 {MAX_ATTACHMENTS} 个附件', 'warn')
                break
            att = make_attachment(path)
            if att is None:
                self.flash(f'不支持的文件类型：{path.suffix or path.name}', 'warn')
                continue
            self.attachments.append(att)
            added += 1
            threading.Thread(target=self._load_attachment, args=(att,), daemon=True).start()
        if added:
            self.set_expanded(True)
            self._paint_chrome()
            self._autosize_input()
            self._reflow()

    def _load_attachment(self, att: Attachment) -> None:
        if att.kind == IMAGE_KIND:
            load_image(att)
        else:
            load_document(att, self.api)
        self._events.put(('att', att))

    def remove_attachment(self, att: Attachment) -> None:
        if att in self.attachments:
            self.attachments.remove(att)
            self._paint_chrome()
            self._autosize_input()
            self._reflow()

    def _remove_attachment_at(self, index: int) -> None:
        if 0 <= index < len(self.attachments):
            self.remove_attachment(self.attachments[index])

    # ── 语音 ────────────────────────────────────────

    def toggle_voice(self) -> None:
        if self.running:
            self.flash('执行中可以打字，语音等这一轮结束', 'warn')
            return
        if self.voice_state == 'listening':
            self.stop_voice()
            return
        if self._dictation is None:
            try:
                from .voice import Dictation
            except Exception as err:
                self.flash(f'语音不可用：{err}', 'danger')
                return
            self._dictation = Dictation(self._voice_emit)
        if not self._dictation.available():
            self.flash('这台电脑没有可用的语音识别，先用键盘吧', 'warn')
            return
        self.set_expanded(True)
        if self._dictation.start():
            self.voice_state = 'listening'
            self._paint_chrome()
            self._start_pulse()
        else:
            self.flash(self._dictation.last_error or '语音启动失败', 'warn')

    def stop_voice(self) -> None:
        if self._dictation is not None:
            self._dictation.stop()
        self.voice_state = 'idle'
        self._paint_chrome()

    def _voice_emit(self, kind: str, payload: Any = None) -> None:
        self._events.put(('voice', (kind, payload)))

    def _on_voice_event(self, kind: str, payload: Any) -> None:
        if kind == 'text':
            text = str(payload or '').strip()
            if not text:
                return
            if self._placeholder:
                self._hide_placeholder()
            self.input.insert('end', text)
            self._autosize_input()
            self._paint_chrome()
        elif kind == 'started':
            self.voice_state = 'listening'
            self._paint_chrome()
            self._start_pulse()
        elif kind == 'done':
            self.voice_state = 'idle'
            got = isinstance(payload, dict) and bool(payload.get('got'))
            self._paint_chrome()
            self.flash('听完了' if got else '没有听清，再说一次或直接打字', 'ink' if got else 'warn')
        elif kind == 'error':
            self.voice_state = 'idle'
            self._paint_chrome()
            self.flash(str(payload) or '语音识别出错', 'warn')

    # ── 发送 ────────────────────────────────────────

    def send(self) -> None:
        if not self.open:
            self.open_board()
        if self._external_idle():
            self.flash('主界面有对话正在执行')
            return
        if self.running:
            self.flash('这一轮还在执行')
            return
        if self.voice_state == 'listening':
            self.stop_voice()
        text = self._input_text()
        ready = [a for a in self.attachments if a.ready]
        if any(a.status == 'loading' for a in self.attachments):
            self.flash('文件还在读取，稍等一下', 'warn')
            return
        if any(a.status == 'error' for a in self.attachments):
            self.flash('有文件没读成功，先移除它', 'warn')
            return
        images = [a.data_url for a in ready if a.kind == IMAGE_KIND]
        if not text and not ready:
            self.flash('说点什么，或者加一个文件', 'warn')
            self.focus_input()
            return
        if not self.connected:
            self.flash('主应用没连上', 'warn')
            self.cb['on_check_connection']()
            return
        payload = compose_message(text, ready)
        display_text = text or '（附件）'
        self.attachments = []
        self._clear_input()
        self.begin_run(display_text)
        self.cb['on_send'](payload, images)

    # ═══════════════════════════════════════════════════
    # 计时 / 呼吸
    # ═══════════════════════════════════════════════════

    def _start_pulse(self) -> None:
        if self._pulse_job is None:
            self._pulse_phase = 0
            self._pulse_tick()

    def _stop_pulse(self) -> None:
        if self._pulse_job is not None:
            try:
                self.root.after_cancel(self._pulse_job)
            except Exception:
                pass
            self._pulse_job = None

    def _pulse_tick(self) -> None:
        if self._closing:
            self._pulse_job = None
            return
        if self.state != 'running' and self.voice_state != 'listening':
            self._pulse_job = None
            return
        self._pulse_phase = (self._pulse_phase + 1) % 12
        for canvas, items in (
            (self.chrome, self._top_dots),
            (self.body, self._body_dots),
        ):
            for index, item in enumerate(items):
                on = ((self._pulse_phase + index * 4) % 12) < 5
                try:
                    canvas.itemconfigure(
                        item, fill=COLOR['accent'] if on else COLOR['accent_soft']
                    )
                except Exception:
                    pass
        if self._voice_ring is not None:
            width = 1 + int((self._pulse_phase % 6) * 0.5)
            try:
                self.chrome.itemconfigure(self._voice_ring, width=self.t.px(width))
            except Exception:
                pass
        self._pulse_job = self.root.after(180, self._pulse_tick)

    # ═══════════════════════════════════════════════════
    # 收尾
    # ═══════════════════════════════════════════════════

    @staticmethod
    def _friendly_error(message: str) -> str:
        text = (message or '').strip()
        low = text.lower()
        if (
            '10061' in text
            or '积极拒绝' in text
            or 'connection refused' in low
            or '连不上主应用' in text
        ):
            return '主应用没在运行，或者端口不对。'
        if '10060' in text or 'timed out' in low or '超时' in text:
            return '主应用没有响应，等一会儿再试。'
        if not text:
            return '这一轮出错了，再试一次看看。'
        return text if len(text) <= 300 else text[:300].rstrip() + '…'

    @staticmethod
    def _clean_answer(text: str, limit: int | None = 6000) -> str:
        """轻量 Markdown 清理；历史调用 `limit=None`，保证完整不截断。

        无历史时的当前答复仍沿用旧的 6000 字保护；finished 后历史会接上，
        同一个答复由完整历史替换（按 message id 去重）。
        """
        out: list[str] = []
        for raw in text.replace('\r\n', '\n').split('\n'):
            line = raw.rstrip()
            stripped = line.lstrip()
            if stripped.startswith('```'):
                continue
            if stripped.startswith('#'):
                line = stripped.lstrip('#').strip()
            if stripped.startswith(('- ', '* ', '• ')):
                line = '· ' + stripped[2:]
            line = line.replace('**', '').replace('__', '').replace('`', '')
            out.append(line)
        cleaned = '\n'.join(out).strip()
        if limit is not None and len(cleaned) > limit:
            cleaned = cleaned[:limit].rstrip() + '\n\n（内容太长，完整答复请在主界面查看）'
        return cleaned

    def reset_idle(self) -> None:
        self.state = 'idle'
        self.last_user = ''
        self.last_user_id = ''
        self.narration = ''
        self.answer = ''
        self.answer_id = ''
        self.error_text = ''
        self.stage = ''
        self.started_at = 0.0
        self.voice_state = 'idle'
        self._follow_first_history = False
        self._stop_pulse()
        if self.open:
            if self._external_idle():
                self.expanded = False
                self.composer_h.to(0)
                self.input.place_forget()
            else:
                self.expanded = True
                self.composer_h.to(self._composer_full_h())
            self._paint_all()
            self._reflow()
            if not self._external_idle():
                self.root.after(30, self.focus_input)
        self._sync_placeholder()

    def _open_web_active(self) -> None:
        if self.web_active is None:
            return
        session = self.web_active.get('sessionId')
        if isinstance(session, str) and session:
            self.cb['on_open_conversation'](session)

    def destroy(self) -> None:
        self._closing = True
        if self._dictation is not None:
            try:
                self._dictation.stop()
            except Exception:
                pass
        for job in (self._anim_job, self._pulse_job):
            if job is not None:
                try:
                    self.root.after_cancel(job)
                except Exception:
                    pass
        self.tooltip.destroy()
        self.toast.destroy()
