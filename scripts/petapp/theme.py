"""桌宠的视觉令牌与字体。

★ 一屏只有一个强调色，其余靠留白分层：
  桌面窗口没有 CSS 的阴影与圆角，能做的是「色阶 + 间距 + 一条发丝线」。
  所以这里的每个数值都要有理由，而不是随手调。

★ 尺寸单位是「逻辑像素」，由 DPI 缩放因子乘成物理像素。
  字体用**负数像素号**（Tk 里 `-16` 表示 16 像素），这样 125% 缩放下
  文字与留白一起放大，不会出现「字变大、盒子没变」的错位。
"""

from __future__ import annotations

import tkinter as tk
import tkinter.font as tkfont

# ═══════════════════════════════════════════════════════════
# 配色
# ═══════════════════════════════════════════════════════════
#
# 暖纸底 + 墨色字 + 苔绿点缀。米色要在桌面上立得住，
# 既不能亮成纯白（和浏览器窗口抢），也不能黄到发旧。
# 每一层只差一点点 —— 层级靠的是「相邻两层足够近」而不是描边。

TRANSPARENT = '#010203'

COLOR = {
    'board': '#FBF6EA',        # 桌板主色
    'board_soft': '#F5ECDB',   # 引用块 / 悬停底
    'board_edge': '#E8D9BE',   # 桌板描边
    'board_glow': '#FFFDF7',   # 顶边高光
    'divider': '#EFE3CE',      # 发丝线

    'field': '#FFFDF8',        # 输入框底
    'field_edge': '#E7D8BC',

    'ink': '#3B3225',
    'ink_2': '#6A5B47',
    'ink_3': '#98886F',
    'ink_4': '#B6A78C',

    'accent': '#4F7159',
    'accent_ink': '#3D5A46',
    'accent_soft': '#E9F0E5',
    'accent_line': '#BFD2C1',

    'warn': '#9E652C',
    'warn_soft': '#F7EDDC',
    'danger': '#A5492F',
    'danger_soft': '#F8E8E1',

    'hover': '#F2E7D3',
    'shadow': '#E3D3B7',
}

FAMILY_CANDIDATES = (
    'Microsoft YaHei UI',
    'Microsoft YaHei',
    '微软雅黑',
    'PingFang SC',
    'Segoe UI',
)


def pick_family(root: tk.Misc) -> str:
    """挑一个本机存在的字体族。缺字体时 Tk 会静默回退，那时字会很难看。"""
    try:
        installed = set(tkfont.families(root))
    except Exception:
        return 'TkDefaultFont'
    for name in FAMILY_CANDIDATES:
        if name in installed:
            return name
    return 'TkDefaultFont'


class Theme:
    """把逻辑尺寸换算成当前屏幕的物理尺寸。"""

    def __init__(self, root: tk.Misc) -> None:
        try:
            dpi = float(root.winfo_fpixels('1i'))
        except Exception:
            dpi = 96.0
        # 96 是 Windows 的基准 DPI；120 → 1.25 倍，144 → 1.5 倍
        self.scale = max(0.85, min(2.2, dpi / 96.0))
        self.family = pick_family(root)

        # ---- 版式（逻辑像素）----
        # 桌板就是输入框本身：只有一层米色圆角面，没有状态栏、没有内嵌卡片。
        self.board_w = 378
        self.pad = 8              # 桌板内边距（上/下）；输入文字距上沿 8px
        self.body_pad = 14        # 正文/输入的左右留白
        self.radius = 18          # 四角同半径
        self.action_h = 30
        self.top_row_h = 30
        self.body_gap = 6
        self.att_chip_h = 22
        self.att_gap = 6
        self.max_body_h = 396
        self.min_board_h = 64
        self.line = 1.58  # 行高倍率；Tk 的 canvas 没有行距选项，按行画

        # ---- 语气词 ----
        self.text = {
            'status': 11.5,
            'stage': 11.0,
            'quote': 12.2,
            'answer': 13.0,
            'meta': 10.5,
            'hint': 12.0,
            'input': 13.0,
            'chip': 11.0,
            'button': 11.5,
            'badge': 9.0,
            'tooltip': 10.5,
            'menu_title': 10.5,
            'menu_small': 10.0,
            'menu_model': 13.0,
            'menu_item': 12.0,
        }

        self.fonts: dict[str, tkfont.Font] = {}
        for key, size in self.text.items():
            self.fonts[key] = tkfont.Font(
                root=root, family=self.family, size=-self.px(size), weight='normal'
            )
        self.fonts['status_bold'] = tkfont.Font(
            root=root, family=self.family, size=-self.px(self.text['status']), weight='bold'
        )
        self.fonts['button_bold'] = tkfont.Font(
            root=root, family=self.family, size=-self.px(self.text['button']), weight='bold'
        )

    # ── 换算 ──────────────────────────────────────────

    def px(self, value: float) -> int:
        return int(round(value * self.scale))

    def fpx(self, value: float) -> float:
        return value * self.scale

    def line_h(self, font_key: str) -> int:
        """行高 = 字号 × 行高倍率。

        ⚠️ 不能用 `font.metrics('linespace')` —— 那是字体自带的行距（约 1.2），
           中文正文按 1.2 排会挤成一坨；这里按视觉需要自己定。
        """
        return int(round(self.text[font_key] * self.line * self.scale))

    def measure(self, font_key: str, text: str) -> int:
        try:
            return int(self.fonts[font_key].measure(text))
        except Exception:
            return int(len(text) * self.text[font_key] * self.scale)
