"""桌板上的绘图工具：圆角、文字折行、小图标。

★ 为什么自己折行，而不是用 canvas 的 `width=`：
  Tk 的 canvas 文本没有行距选项，中文正文按字体自带行距排会挤；
  而"不拥挤"是这次设计的第一条要求。自己折行才能把行高定成 1.66 倍。
  代价是要自己量字宽 —— 用二分查找把每行的测量次数压到 log(n)。

★ 折行规则：
  · 中文逐字可断，英文优先在空格处断（避免 half-a-word 掉到下一行）；
  · 行首标点（，。、；：！？）不落在行首 —— 挤回上一行，
    中文排版里这条很显眼，不做的话看起来像业余排版。
"""

from __future__ import annotations

import math
from typing import Iterable

import tkinter.font as tkfont

from PIL import Image, ImageColor, ImageDraw, ImageTk

# 不能出现在行首的标点
_NO_LINE_START = set('，。、；：！？）》」』】…·%,.;:!?)]}')
# 不能出现在行尾的标点
_NO_LINE_END = set('（《「『【([{')


def blend(color_a: str, color_b: str, t: float) -> str:
    """两个 #RRGGBB 之间线性插值；t=0 → a，t=1 → b。"""
    t = max(0.0, min(1.0, t))
    a = color_a.lstrip('#')
    b = color_b.lstrip('#')
    try:
        ar, ag, ab = int(a[0:2], 16), int(a[2:4], 16), int(a[4:6], 16)
        br, bg, bb = int(b[0:2], 16), int(b[2:4], 16), int(b[4:6], 16)
    except Exception:
        return color_a
    return '#%02x%02x%02x' % (
        int(round(ar + (br - ar) * t)),
        int(round(ag + (bg - ag) * t)),
        int(round(ab + (bb - ab) * t)),
    )


def rounded_points(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    r_tl: float,
    r_tr: float,
    r_br: float,
    r_bl: float,
    steps: int = 7,
) -> list[float]:
    """圆角矩形的多边形顶点（顺时针，从左上角之后开始）。

    ⚠️ Tk 没有抗锯齿的 `rounded_rectangle`；用 `create_polygon` 铺点
       是唯一能在透明窗口里保持形状的办法（不引入 alpha 混色）。
    """
    pts: list[float] = []
    # 左上
    for i in range(steps + 1):
        ang = math.pi + (math.pi / 2) * (i / steps)
        pts.extend([x1 + r_tl + math.cos(ang) * r_tl, y1 + r_tl + math.sin(ang) * r_tl])
    # 右上
    for i in range(steps + 1):
        ang = -math.pi / 2 + (math.pi / 2) * (i / steps)
        pts.extend([x2 - r_tr + math.cos(ang) * r_tr, y1 + r_tr + math.sin(ang) * r_tr])
    # 右下
    for i in range(steps + 1):
        ang = 0 + (math.pi / 2) * (i / steps)
        pts.extend([x2 - r_br + math.cos(ang) * r_br, y2 - r_br + math.sin(ang) * r_br])
    # 左下
    for i in range(steps + 1):
        ang = math.pi / 2 + (math.pi / 2) * (i / steps)
        pts.extend([x1 + r_bl + math.cos(ang) * r_bl, y2 - r_bl + math.sin(ang) * r_bl])
    return pts


# ═══════════════════════════════════════════════════════════
# 文字折行
# ═══════════════════════════════════════════════════════════


class TextWrapper:
    """带缓存的折行器。

    ★ 缓存键包含文本、宽度、字体 id —— 流式时文本每来一片就变，
      所以缓存更多是给"同一段话重绘"用的（滚动、动画帧）。
      真正让流式不卡的是二分查找：一行只量 log(n) 次。
    """

    def __init__(self) -> None:
        self._cache: dict[tuple[int, int, str], list[str]] = {}
        self._order: list[tuple[int, int, str]] = []

    def lines(self, font: tkfont.Font, text: str, width: int) -> list[str]:
        if width <= 8:
            return [text] if text else ['']
        key = (id(font), width, text)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        out = self._wrap(font, text, width)
        self._cache[key] = out
        self._order.append(key)
        if len(self._order) > 64:
            old = self._order.pop(0)
            self._cache.pop(old, None)
        return out

    def _wrap(self, font: tkfont.Font, text: str, width: int) -> list[str]:
        out: list[str] = []
        for para in text.split('\n'):
            if para == '':
                out.append('')
                continue
            out.extend(self._wrap_paragraph(font, para, width))
        return out

    def _wrap_paragraph(self, font: tkfont.Font, para: str, width: int) -> list[str]:
        lines: list[str] = []
        remaining = para
        while remaining:
            if font.measure(remaining) <= width:
                lines.append(remaining)
                break
            # 二分找最长可容纳前缀
            lo, hi = 1, len(remaining)
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if font.measure(remaining[:mid]) <= width:
                    lo = mid
                else:
                    hi = mid - 1
            cut = max(1, lo)
            # 英文优先在空格断行
            if cut < len(remaining) and remaining[cut].isascii() and remaining[cut].isalnum():
                space = remaining.rfind(' ', max(1, cut - 24), cut)
                if space > 0:
                    cut = space
            # 中文标点避头尾
            while cut < len(remaining) and remaining[cut] in _NO_LINE_START and cut > 1:
                cut -= 1
            while cut > 1 and remaining[cut - 1] in _NO_LINE_END:
                cut -= 1
            piece = remaining[:cut].rstrip()
            if piece == '':
                piece = remaining[:cut]
            lines.append(piece)
            remaining = remaining[cut:].lstrip(' ')
        return lines


def ellipsize(font: tkfont.Font, text: str, width: int) -> str:
    """单行截断，末尾加省略号。量宽度用同一种字体，安卓/Windows 都一致。"""
    text = text.replace('\n', ' ')
    if width <= 4 or font.measure(text) <= width:
        return text
    ell = '…'
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if font.measure(text[:mid] + ell) <= width:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo].rstrip() + ell


def format_elapsed(seconds: float) -> str:
    """执行用时：小于一分钟用「12 秒」，之后用「1:24」。"""
    total = max(0, int(seconds))
    if total < 60:
        return f'{total} 秒'
    return f'{total // 60}:{total % 60:02d}'


def human_size(num: int) -> str:
    if num < 1024:
        return f'{num} B'
    if num < 1024 * 1024:
        return f'{num / 1024:.0f} KB'
    return f'{num / 1024 / 1024:.1f} MB'


# ═══════════════════════════════════════════════════════════
# 小图标（全部用线段画，不用 emoji —— emoji 在 Tk 里大小对不齐）
# ═══════════════════════════════════════════════════════════


def icon_file(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.3, tag: str = '') -> None:
    """一张纸：外框 + 折角 + 两条内容线。"""
    s = size
    x, y = cx - s / 2, cy - s / 2
    k = s * 0.34
    canvas.create_line(
        x + s * 0.16, y,
        x + s * 0.66, y,
        x + s, y + k,
        x + s, y + s * 0.86,
        x + s * 0.84, y + s,
        x + s * 0.16, y + s,
        x, y + s * 0.86,
        x, y + s * 0.14,
        x + s * 0.16, y,
        fill=color, width=width, joinstyle='round', capstyle='round', tags=(tag, 'icon'),
    )
    canvas.create_line(
        x + s * 0.66, y, x + s * 0.66, y + k, x + s, y + k,
        fill=color, width=width, joinstyle='round', capstyle='round', tags=(tag, 'icon'),
    )
    for ratio in (0.46, 0.66):
        canvas.create_line(
            x + s * 0.22, y + s * ratio, x + s * 0.7, y + s * ratio,
            fill=color, width=max(1.0, width - 0.2), capstyle='round', tags=(tag, 'icon'),
        )


def _mic_photo(canvas, size: float, color: str, width: float) -> ImageTk.PhotoImage:
    """把 Web 的 24×24 麦克风图标离屏画成抗锯齿位图。

    Tk Canvas 的 line/arc 没有抗锯齿；直接画在 15px 上会出现台阶。
    这里按 8 倍超采样绘制，再用 LANCZOS 缩到目标尺寸，最后作为
    透明 PhotoImage 贴回 canvas。
    """
    scale = 8
    side = max(8, int(round(size * scale)))
    image = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    rgb = ImageColor.getrgb(color)
    ink = (*rgb, 255)
    stroke = max(1, int(round(width * scale)))
    u = side / 24.0

    def xy(value: float) -> float:
        return value * u

    # 胶囊：rect(9,3.5,15,14.5, rx=3)，PIL 的 width 是内缩描边。
    draw.rounded_rectangle(
        (xy(9.0), xy(3.5), xy(15.0), xy(14.5)),
        radius=xy(3.0),
        outline=ink,
        width=stroke,
    )

    # 托架：PIL 角度 0=东、顺时针增加；0..180 是下半圆。
    draw.arc(
        (xy(5.5), xy(5.0), xy(18.5), xy(18.0)),
        start=0,
        end=180,
        fill=ink,
        width=stroke,
    )
    # arc 没有圆头，补两端圆帽。
    cap = stroke / 2.0
    for cap_x in (5.5, 18.5):
        draw.ellipse(
            (xy(cap_x) - cap, xy(11.5) - cap, xy(cap_x) + cap, xy(11.5) + cap),
            fill=ink,
        )

    # 支杆 + 底座。
    draw.line(
        (xy(12.0), xy(18.0), xy(12.0), xy(21.0)),
        fill=ink,
        width=stroke,
    )
    draw.line(
        (xy(8.5), xy(21.0), xy(15.5), xy(21.0)),
        fill=ink,
        width=stroke,
    )
    for end_x, end_y in ((12.0, 18.0), (12.0, 21.0), (8.5, 21.0), (15.5, 21.0)):
        draw.ellipse(
            (xy(end_x) - cap, xy(end_y) - cap, xy(end_x) + cap, xy(end_y) + cap),
            fill=ink,
        )

    target = max(1, int(round(size)))
    return ImageTk.PhotoImage(
        image.resize((target, target), Image.Resampling.LANCZOS),
        master=canvas.winfo_toplevel(),
    )


def icon_mic(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.4, tag: str = '') -> None:
    """线性麦克风：按 Web 的 24×24 几何渲染为抗锯齿透明图片。"""
    cache = getattr(canvas, '_mic_icon_cache', None)
    if not isinstance(cache, dict):
        cache = {}
        setattr(canvas, '_mic_icon_cache', cache)
    key = (round(size, 2), round(width, 2), color)
    photo = cache.get(key)
    if photo is None:
        photo = _mic_photo(canvas, size, color, width)
        cache[key] = photo
    canvas.create_image(cx, cy, image=photo, anchor='center', tags=(tag, 'icon'))


def icon_arrow(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.5, tag: str = '') -> None:
    """发送：一支右箭头。"""
    s = size
    x = cx - s / 2
    canvas.create_line(
        x + s * 0.06, cy, x + s * 0.92, cy,
        fill=color, width=width, capstyle='round', tags=(tag, 'icon'),
    )
    canvas.create_line(
        x + s * 0.6, cy - s * 0.3, x + s * 0.92, cy, x + s * 0.6, cy + s * 0.3,
        fill=color, width=width, joinstyle='round', capstyle='round', tags=(tag, 'icon'),
    )


def icon_arrow_up(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.6, tag: str = '') -> None:
    """发送：向上箭头（与输入框底部对齐）。"""
    s = size
    canvas.create_line(
        cx, cy + s * 0.42, cx, cy - s * 0.4,
        fill=color, width=width, capstyle='round', tags=(tag, 'icon'),
    )
    canvas.create_line(
        cx - s * 0.28, cy - s * 0.12,
        cx, cy - s * 0.4,
        cx + s * 0.28, cy - s * 0.12,
        fill=color, width=width, joinstyle='round', capstyle='round', tags=(tag, 'icon'),
    )


def icon_plus(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.6, tag: str = '') -> None:
    """添加文件：一个加号。"""
    s = size
    canvas.create_line(
        cx - s * 0.4, cy, cx + s * 0.4, cy,
        fill=color, width=width, capstyle='round', tags=(tag, 'icon'),
    )
    canvas.create_line(
        cx, cy - s * 0.4, cx, cy + s * 0.4,
        fill=color, width=width, capstyle='round', tags=(tag, 'icon'),
    )


def icon_pencil(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.4, tag: str = '') -> None:
    """展开输入：一支小铅笔。"""
    s = size
    x, y = cx - s / 2, cy - s / 2
    canvas.create_line(
        x + s * 0.18, y + s * 0.72,
        x + s * 0.72, y + s * 0.18,
        fill=color, width=width, capstyle='round', tags=(tag, 'icon'),
    )
    canvas.create_line(
        x + s * 0.18, y + s * 0.72,
        x + s * 0.4, y + s * 0.76,
        x + s * 0.28, y + s * 0.58,
        fill=color, width=max(1.0, width - 0.2), joinstyle='round', capstyle='round',
        tags=(tag, 'icon'),
    )


def icon_check(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.8, tag: str = '') -> None:
    """勾选。"""
    s = size
    canvas.create_line(
        cx - s * 0.38, cy,
        cx - s * 0.08, cy + s * 0.3,
        cx + s * 0.42, cy - s * 0.34,
        fill=color, width=width, joinstyle='round', capstyle='round', tags=(tag, 'icon'),
    )


def icon_chevron(
    canvas,
    cx: float,
    cy: float,
    size: float,
    color: str,
    *,
    up: bool = True,
    width: float = 1.5,
    tag: str = '',
) -> None:
    s = size
    dy = -s * 0.18 if up else s * 0.18
    canvas.create_line(
        cx - s * 0.34, cy + dy, cx, cy - dy, cx + s * 0.34, cy + dy,
        fill=color, width=width, joinstyle='round', capstyle='round', tags=(tag, 'icon'),
    )


def icon_close(canvas, cx: float, cy: float, size: float, color: str, width: float = 1.3, tag: str = '') -> None:
    s = size
    canvas.create_line(
        cx - s * 0.28, cy - s * 0.28, cx + s * 0.28, cy + s * 0.28,
        fill=color, width=width, capstyle='round', tags=(tag, 'icon'),
    )
    canvas.create_line(
        cx + s * 0.28, cy - s * 0.28, cx - s * 0.28, cy + s * 0.28,
        fill=color, width=width, capstyle='round', tags=(tag, 'icon'),
    )


def icon_stop(canvas, cx: float, cy: float, size: float, color: str, tag: str = '') -> None:
    s = size
    canvas.create_rectangle(
        cx - s * 0.24, cy - s * 0.24, cx + s * 0.24, cy + s * 0.24,
        fill=color, outline='', tags=(tag, 'icon'),
    )


def dots(canvas, x: float, y: float, count: int, gap: float, radius: float, color: str, tag: str = '') -> None:
    for index in range(count):
        canvas.create_oval(
            x + index * gap - radius, y - radius,
            x + index * gap + radius, y + radius,
            fill=color, outline='', tags=(tag, 'icon'),
        )


def segments_for(text: str, max_chars: int) -> Iterable[str]:
    """把长文本切成分片的关键词，用来在等宽/窄空间里做渐显。"""
    step = max(1, max_chars)
    for index in range(0, len(text), step):
        yield text[index : index + step]
