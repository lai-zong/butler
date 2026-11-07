"""找到并聚焦已经打开的 butler Web 窗口（Windows）。

桌宠的「打开当前对话」优先复用用户已经开着的页面：新开浏览器窗口会把
用户当前的 Web 会话打断，也容易叠出好几个标签页。

★ 只认**浏览器进程**里标题带 butler 标识的可见顶层窗口。
  资源管理器打开这个项目文件夹时标题里也有 "butler"，编辑器 / DSH 窗口
  同样可能带项目名；光看标题会误聚焦，所以进程名必须命中浏览器白名单。

★ 非 Windows 一律返回 0 / False，调用方退回 `webbrowser.open`。
"""

from __future__ import annotations

import ctypes
import os
import sys

# Web 页面 <title> 是 "butler · 记忆治理"；浏览器会把标签标题拼进窗口标题
# （"… - Microsoft Edge"）。这里不区分大小写。
TITLE_MARKERS = ('butler', '管家', '记忆治理')

# 只认真正的浏览器：避免误聚焦资源管理器、编辑器、DSH 等带项目名的窗口。
BROWSER_EXES = frozenset(
    {
        'chrome.exe',
        'msedge.exe',
        'firefox.exe',
        'brave.exe',
        'vivaldi.exe',
        'opera.exe',
        'opera_gx.exe',
        'chromium.exe',
        'iexplore.exe',
        'safari.exe',
        # 国内常见壳浏览器：它们也是真浏览器窗口，不收录会退化成新开窗口。
        '360se.exe',
        '360chromex.exe',
        'qqbrowser.exe',
        'sogouexplorer.exe',
        'maxthon.exe',
        'liebao.exe',
        '2345explorer.exe',
        'ucbrowser.exe',
        'theworld.exe',
    }
)

SW_RESTORE = 9
SW_SHOW = 5
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080

_available = sys.platform == 'win32'
_user32: ctypes.WinDLL | None = None
_kernel32: ctypes.WinDLL | None = None
_WNDENUMPROC: object | None = None

if _available:
    from ctypes import wintypes

    _user32 = ctypes.WinDLL('user32', use_last_error=True)
    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

    # 显式声明参数/返回类型：HWND / HANDLE 是指针宽度，按默认 c_int
    # 传递在 64 位上会被截断，SetForegroundWindow 就会静默失败。
    _WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    _user32.EnumWindows.argtypes = (_WNDENUMPROC, wintypes.LPARAM)
    _user32.EnumWindows.restype = wintypes.BOOL
    _user32.IsWindow.argtypes = (wintypes.HWND,)
    _user32.IsWindow.restype = wintypes.BOOL
    _user32.IsWindowVisible.argtypes = (wintypes.HWND,)
    _user32.IsWindowVisible.restype = wintypes.BOOL
    _user32.IsIconic.argtypes = (wintypes.HWND,)
    _user32.IsIconic.restype = wintypes.BOOL
    _user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
    _user32.GetWindowTextLengthW.restype = ctypes.c_int
    _user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
    _user32.GetWindowTextW.restype = ctypes.c_int
    _user32.GetWindowThreadProcessId.argtypes = (
        wintypes.HWND,
        ctypes.POINTER(wintypes.DWORD),
    )
    _user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    _user32.GetWindowLongW.argtypes = (wintypes.HWND, ctypes.c_int)
    _user32.GetWindowLongW.restype = wintypes.LONG
    _user32.GetForegroundWindow.argtypes = ()
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
    _user32.ShowWindow.restype = wintypes.BOOL
    _user32.BringWindowToTop.argtypes = (wintypes.HWND,)
    _user32.BringWindowToTop.restype = wintypes.BOOL
    _user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
    _user32.SetForegroundWindow.restype = wintypes.BOOL
    _user32.SetFocus.argtypes = (wintypes.HWND,)
    _user32.SetFocus.restype = wintypes.HWND
    _user32.AttachThreadInput.argtypes = (
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.BOOL,
    )
    _user32.AttachThreadInput.restype = wintypes.BOOL

    _kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.QueryFullProcessImageNameW.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    )
    _kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _kernel32.CloseHandle.restype = wintypes.BOOL
    _kernel32.GetCurrentThreadId.argtypes = ()
    _kernel32.GetCurrentThreadId.restype = wintypes.DWORD


def available() -> bool:
    """当前平台能否枚举/聚焦 Windows 顶层窗口。"""
    return bool(_available and _user32 is not None and _kernel32 is not None)


def find_butler_window() -> int:
    """返回标题像 butler Web 页的浏览器顶层窗口句柄；找不到返回 0。

    多个候选时优先「没最小化 + 当前前台」的那个：用户刚在哪个窗口里看
    butler，就回到哪个窗口，而不是把另一个最小化的窗口拽出来。
    """
    if not available():
        return 0
    assert _user32 is not None
    candidates: list[int] = []
    try:
        handles = _enum_windows()
    except Exception:
        return 0
    for hwnd in handles:
        try:
            if _is_butler_candidate(hwnd):
                candidates.append(hwnd)
        except Exception:
            continue
    if not candidates:
        return 0
    foreground = _get_foreground()

    def score(hwnd: int) -> int:
        value = 0
        try:
            if not _user32.IsIconic(hwnd):
                value += 10
            if hwnd == foreground:
                value += 5
            if _window_title(hwnd).casefold().startswith('butler'):
                value += 2
        except Exception:
            pass
        return value

    return max(candidates, key=score)


def focus_window(hwnd: int) -> bool:
    """恢复（若最小化）并把窗口提到前台；成功返回是否真的到了前台。"""
    if not available() or not hwnd:
        return False
    assert _user32 is not None and _kernel32 is not None
    try:
        if not _user32.IsWindow(hwnd):
            return False
        if _user32.IsIconic(hwnd):
            _user32.ShowWindow(hwnd, SW_RESTORE)
        else:
            _user32.ShowWindow(hwnd, SW_SHOW)

        # Windows 的前台锁禁止后台进程直接抢焦点；把当前线程临时挂到
        # 前台窗口的输入队列上，SetForegroundWindow 才会生效。
        current_tid = int(_kernel32.GetCurrentThreadId())
        attached: list[int] = []
        for thread_id in (
            _window_thread_id(_get_foreground()),
            _window_thread_id(hwnd),
        ):
            if (
                thread_id
                and thread_id != current_tid
                and thread_id not in attached
                and _user32.AttachThreadInput(thread_id, current_tid, True)
            ):
                attached.append(thread_id)
        try:
            _user32.BringWindowToTop(hwnd)
            _user32.SetForegroundWindow(hwnd)
            _user32.SetFocus(hwnd)
        finally:
            for thread_id in attached:
                _user32.AttachThreadInput(thread_id, current_tid, False)
        return _get_foreground() == hwnd
    except Exception:
        return False


# ═══════════════════════════════════════════════════════════
# 内部
# ═══════════════════════════════════════════════════════════


def _enum_windows() -> list[int]:
    if not available():
        return []
    assert _user32 is not None and _WNDENUMPROC is not None
    handles: list[int] = []

    def callback(hwnd: int, _lparam: int) -> bool:
        if hwnd:
            handles.append(int(hwnd))
        return True

    _user32.EnumWindows(_WNDENUMPROC(callback), 0)
    return handles


def _is_butler_candidate(hwnd: int) -> bool:
    assert _user32 is not None
    if not _user32.IsWindowVisible(hwnd):
        return False
    if _user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
        return False

    title = _window_title(hwnd)
    if not title:
        return False
    lowered = title.casefold()
    if not any(marker in lowered for marker in TITLE_MARKERS):
        return False

    pid = _window_pid(hwnd)
    if not pid or pid == os.getpid():
        return False
    return _process_exe_name(pid) in BROWSER_EXES


def _window_title(hwnd: int) -> str:
    assert _user32 is not None
    length = int(_user32.GetWindowTextLengthW(hwnd))
    if length <= 0:
        return ''
    buffer = ctypes.create_unicode_buffer(length + 1)
    _user32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value.strip()


def _window_pid(hwnd: int) -> int:
    assert _user32 is not None
    pid = ctypes.c_ulong(0)
    _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _window_thread_id(hwnd: int) -> int:
    assert _user32 is not None
    if not hwnd:
        return 0
    return int(_user32.GetWindowThreadProcessId(hwnd, None))


def _process_exe_name(pid: int) -> str:
    assert _kernel32 is not None
    handle = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ''
    try:
        size = ctypes.c_ulong(1024)
        buffer = ctypes.create_unicode_buffer(1024)
        ok = _kernel32.QueryFullProcessImageNameW(
            handle, 0, buffer, ctypes.byref(size)
        )
        if not ok:
            return ''
        return os.path.basename(buffer.value).casefold()
    finally:
        _kernel32.CloseHandle(handle)


def _get_foreground() -> int:
    assert _user32 is not None
    return int(_user32.GetForegroundWindow() or 0)
