"""系统托盘 —— 桌宠被隐藏之后唯一还看得见的入口。

★ 托盘只做"桌宠不在了"之后还需要的动作：
  叫回来、打开对话板、回到当前对话、置顶、退出。
  执行控制与剪贴板不在这里，也不在右键菜单里 —— 停止只在桌板内。

★ pystray 在 Windows 上可以跑在非主线程；Tk 必须留在主线程。
  所以托盘线程只负责把动作丢进队列，所有窗口操作仍在 Tk 线程里做。
"""

from __future__ import annotations

import threading
from typing import Any, Callable

try:
    import pystray  # type: ignore
    from pystray import Menu as PystrayMenu
    from pystray import MenuItem as PystrayItem
except Exception:  # pragma: no cover —— 没装 pystray 就只是没有托盘
    pystray = None
    PystrayMenu = None
    PystrayItem = None


class SystemTray:
    def __init__(
        self,
        image: Any,
        on_action: Callable[[str], None],
        state: Callable[[], dict[str, Any]],
    ) -> None:
        self.image = image
        self.on_action = on_action
        self.state = state
        self._icon: Any = None
        self._thread: threading.Thread | None = None

    @property
    def available(self) -> bool:
        return pystray is not None

    def start(self) -> bool:
        if pystray is None:
            return False
        try:
            self._icon = pystray.Icon('butler-pet', self.image, 'butler 桌宠', self._build_menu())
            self._thread = threading.Thread(target=self._icon.run, daemon=True)
            self._thread.start()
            return True
        except Exception:
            self._icon = None
            return False

    def refresh(self, title: str | None = None) -> None:
        if self._icon is None:
            return
        try:
            if title is not None:
                self._icon.title = title
            self._icon.update_menu()
        except Exception:
            pass

    def stop(self) -> None:
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:
                pass
            self._icon = None

    # ── 菜单 ────────────────────────────────────────

    def _build_menu(self) -> Any:
        Item = PystrayItem
        Menu = PystrayMenu
        return Menu(
            Item('显示桌宠', lambda: self.on_action('show'), checked=lambda _i: self.state()['visible']),
            Item('打开对话板', lambda: self.on_action('toggle_board'), default=True),
            Item('打开当前对话', lambda: self.on_action('open_conversation')),
            Menu.SEPARATOR,
            Item(
                '窗口置顶',
                lambda: self.on_action('toggle_topmost'),
                checked=lambda _i: self.state()['topmost'],
            ),
            Menu.SEPARATOR,
            Item('退出', lambda: self.on_action('quit')),
        )
