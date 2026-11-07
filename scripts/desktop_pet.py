#!/usr/bin/env python3
"""butler 桌宠 —— 一个不依赖浏览器的常驻桌面窗口。

设计边界（与产品讨论一致）：
  · 透明人物 + 可展开的“桌板”；
  · 桌板只展示模型自己说出来的阶段正文，不展示思考、工具参数、工具结果；
  · 当前只让最新阶段占据视野，旧阶段留在可滚动历史里；
  · 对话走现有 /api/chat，固定使用一个会话，内容仍在现有会话/事件流里；
  · 设置由 Web 设置页写入 pet-config.json，本进程轮询读取；
  · 右键切换当前模型；思考强度先保存偏好，后端接入前不假装生效；
  · 关闭/隐藏/退出分开：隐藏保留进程和提醒轮询，退出才结束进程。

这个脚本刻意只用标准库 + Tkinter + Pillow + pystray，不把桌宠绑进 Next
构建链。主应用必须先运行；桌宠不复制任何业务逻辑。
"""

from __future__ import annotations

import argparse
import atexit
import ctypes
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import filedialog, messagebox
from PIL import Image, ImageDraw, ImageTk

ROOT_DIR = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("BUTLER_URL", "http://127.0.0.1:3000").rstrip("/")
DATA_DIR = Path(os.environ.get("BUTLER_DATA_DIR", ROOT_DIR / ".butler-data"))
CONFIG_FILE = DATA_DIR / "pet-config.json"
STATE_FILE = DATA_DIR / "pet-state.json"
PID_FILE = DATA_DIR / "pet.pid"
LOCK_FILE = DATA_DIR / "pet.lock"
ASSET_DIR = ROOT_DIR / "public" / "pet"

TRANSPARENT = "#010203"
BOARD_BG = "#4b3c31"
BOARD_BG_2 = "#5a493b"
BOARD_TEXT = "#f7efe3"
BOARD_MUTED = "#c8b8a6"
BOARD_ACCENT = "#9bc7a4"
BOARD_WARN = "#e3b06d"
BOARD_WIDTH = 408
BOARD_MIN_H = 320
BOARD_MAX_H = 360
# 桌板必须贴住人物手部：原图桌板是紧贴手的，当前布局不能留一圈透明边。
# 顶部留一点呼吸区，底部让桌板覆盖 4px，盖住裁图自带的透明底边。
PET_MARGIN_TOP = 4
PET_MARGIN = PET_MARGIN_TOP
# 桌板打开时，把一块桌板色底条合成进图片本身（手部像素盖在底条上）。
# 底条只占图片最下面 16px，人物周围其余区域仍保持透明。
PET_SEAM_HEIGHT = 16
PET_BOARD_OVERLAP = 0
POLL_MS = 20_000
# 设置页保存后，桌宠要尽快看到 size / 顶置 / 启用变化。
# 30 秒会让用户以为“没生效”；配置端点只是本地 JSON，2 秒成本可接受。
CONFIG_POLL_MS = 2_000

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "enabled": True,
    "autoStart": False,
    "size": 220,
    "sprite": "butler",
    "alwaysOnTop": True,
    "model": None,
    "thinkingLevel": "default",
    "persona": "",
}


# ═══════════════════════════════════════════════════════════
# 配置 / 状态
# ═══════════════════════════════════════════════════════════


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def normalize_config(raw: Any) -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if isinstance(raw, dict):
        for key in cfg:
            if key in raw:
                cfg[key] = raw[key]
    try:
        cfg["size"] = max(120, min(480, int(cfg.get("size", 220))))
    except Exception:
        cfg["size"] = 220
    if not isinstance(cfg.get("persona"), str):
        cfg["persona"] = ""
    cfg["persona"] = cfg["persona"][:4000]
    if not isinstance(cfg.get("sprite"), str) or not cfg["sprite"].strip():
        cfg["sprite"] = "butler"
    if cfg.get("thinkingLevel") not in ("default", "low", "medium", "high"):
        cfg["thinkingLevel"] = "default"
    if cfg.get("model") is not None and not (
        isinstance(cfg["model"], dict)
        and isinstance(cfg["model"].get("profileId"), str)
        and isinstance(cfg["model"].get("modelId"), str)
    ):
        cfg["model"] = None
    return cfg


def load_local_config() -> dict[str, Any]:
    return normalize_config(read_json(CONFIG_FILE, DEFAULT_CONFIG))


def save_local_config(cfg: dict[str, Any]) -> None:
    write_json_atomic(CONFIG_FILE, cfg)


def load_state() -> dict[str, Any]:
    raw = read_json(STATE_FILE, {})
    return raw if isinstance(raw, dict) else {}


def save_state(state: dict[str, Any]) -> None:
    write_json_atomic(STATE_FILE, state)


def acquire_instance_lock() -> Any | None:
    """单实例锁。

    设置页的“重新打开”和用户双击 .bat 可能同时发生；只靠 PID 检查有竞态。
    这里用文件锁保证第二个进程即使抢在 PID 写盘前也起不来。
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    handle = None
    try:
        # ⚠️ 锁和 PID 必须分文件：Windows 文件锁会阻止 Node 读 PID，
        # 状态接口就会永远显示“未运行”。锁文件只负责互斥，PID 文件可读。
        handle = open(LOCK_FILE, "a+", encoding="utf-8")
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            if handle.read(1) == "":
                handle.write("0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
        return handle
    except Exception:
        try:
            if handle is not None:
                handle.close()
        except Exception:
            pass
        return None


def release_instance_lock(handle: Any | None) -> None:
    if handle is None:
        return
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except Exception:
        pass
    try:
        handle.close()
    except Exception:
        pass
    try:
        if PID_FILE.exists() and PID_FILE.read_text(encoding="utf-8").strip() == str(os.getpid()):
            PID_FILE.unlink()
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════
# HTTP / SSE
# ═══════════════════════════════════════════════════════════


class ApiError(RuntimeError):
    pass


def api_json(method: str, path: str, body: dict[str, Any] | None = None, timeout: float = 20) -> Any:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(text)
            message = parsed.get("error") or text
        except Exception:
            message = text or str(err)
        raise ApiError(f"HTTP {err.code}: {message}") from err
    except Exception as err:
        raise ApiError(str(err)) from err


def ensure_session(state: dict[str, Any]) -> str:
    existing = state.get("sessionId")
    if isinstance(existing, str) and existing.strip():
        # 只要主应用还在，旧会话可以继续使用；不为了验证存在性阻塞启动。
        return existing
    result = api_json("POST", "/api/sessions", {})
    session_id = result.get("session", {}).get("id")
    if not isinstance(session_id, str) or not session_id:
        raise ApiError("主应用没有返回会话 id")
    state["sessionId"] = session_id
    save_state(state)
    return session_id


def stream_chat(
    text: str,
    session_id: str,
    config: dict[str, Any],
    on_event: Any,
    cancel: threading.Event,
) -> None:
    body: dict[str, Any] = {
        "sessionId": session_id,
        "text": text,
        # 桌宠第一版不处理审批卡：不能声明 supportsApproval，
        # 否则需要确认的工具会等满 120 秒。立即拒绝比静默挂起诚实。
        "supportsApproval": False,
    }
    model = config.get("model")
    if isinstance(model, dict):
        if isinstance(model.get("profileId"), str):
            body["modelProfileId"] = model["profileId"]
        if isinstance(model.get("modelId"), str):
            body["modelId"] = model["modelId"]
    persona = config.get("persona")
    if isinstance(persona, str) and persona.strip():
        body["persona"] = persona.strip()

    req = urllib.request.Request(
        f"{BASE_URL}/api/chat",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            for raw in resp:
                if cancel.is_set():
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                on_event(event)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        raise ApiError(f"HTTP {err.code}: {detail}") from err
    except Exception as err:
        if not cancel.is_set():
            raise ApiError(str(err)) from err


# ═══════════════════════════════════════════════════════════
# 桌宠窗口
# ═══════════════════════════════════════════════════════════


class PetApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.overrideredirect(True)
        self.root.configure(bg=TRANSPARENT)
        self.root.attributes("-transparentcolor", TRANSPARENT)
        self.root.attributes("-topmost", True)

        self.config = load_local_config()
        self.state = load_state()
        self.session_id = self.state.get("sessionId") if isinstance(self.state.get("sessionId"), str) else None
        self._session_lock = threading.Lock()

        self.board_open = False
        self.streaming = False
        self.cancel_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.model_options: list[dict[str, str]] = []
        self.model_loading = False
        self.due_reminders: list[dict[str, Any]] = []
        self.last_task_poll = 0.0
        self._closing = False
        self._drag: dict[str, Any] | None = None
        self._photo: ImageTk.PhotoImage | None = None
        self._base_image: Image.Image | None = None
        self._sprite_image: Image.Image | None = None
        self._pet_w = 0
        self._pet_h = 0
        self._window_w = BOARD_WIDTH
        self._board_h = 0
        self._target_h = 0
        self._tray_icon: Any = None
        self._tray_thread: threading.Thread | None = None
        self._tray_error = ""

        # ---- 根窗口布局：人物在上，桌板在下 ----
        #
        # ★ 必须用 Label 显示人物，不能把 PhotoImage 放进 Canvas：
        #   Windows 的 -transparentcolor 会把 Canvas 整层做成透明，
        #   实测 picture 也一起消失；Label 能正常保留人物像素。
        self.pet_frame = tk.Frame(root, bg=TRANSPARENT, bd=0, highlightthickness=0, cursor="hand2")
        self.pet_frame.pack(side="top", fill="x")
        self.pet_frame.pack_propagate(False)
        self.pet_label = tk.Label(
            self.pet_frame,
            bg=TRANSPARENT,
            bd=0,
            highlightthickness=0,
            cursor="hand2",
            anchor="n",
        )
        self.badge_label = tk.Label(
            self.pet_frame,
            text="",
            bg="#b4533c",
            fg="#fff7ed",
            bd=0,
            padx=6,
            pady=1,
            font=("Microsoft YaHei UI", 9, "bold"),
            cursor="hand2",
        )
        self.board = tk.Frame(root, bg=BOARD_BG, bd=0, highlightthickness=0)

        self._build_board()
        self._bind_pet()
        self._load_sprite()
        self._init_position()
        self._refresh_geometry()

        # 异步拉模型、提醒；不阻塞窗口出现
        self.root.after(300, self._refresh_models)
        self.root.after(600, self._poll_tasks)
        self.root.after(1500, self._poll_config)
        self.root.after(80, self._drain_events)
        self._setup_tray()
        self.root.after(120, self._force_topmost)
        self.root.after(700, self._force_topmost)
        self._keep_topmost()

        self.root.bind_all("<Escape>", self._on_escape)

    # ── 窗口 / 素材 ─────────────────────────────────────

    def _sprite_path(self) -> Path:
        sprite = self.config.get("sprite", "butler")
        candidate = ASSET_DIR / str(sprite) / "base.png"
        if candidate.is_file():
            return candidate
        return ASSET_DIR / "butler" / "base.png"

    def _load_sprite(self) -> None:
        path = self._sprite_path()
        if not path.is_file():
            raise RuntimeError(f"找不到桌宠图片：{path}")
        image = Image.open(path).convert("RGBA")
        # 透明区噪声：AI 导出的图片常常在“透明”区域留下 alpha 1~15 的
        # 紫色噪点。Tk 的 -transparentcolor 会把这些半透明像素混成黑色麻点，
        # 看起来像抠图没扣干净。这里只改 alpha，不动任何颜色像素。
        alpha = image.getchannel("A")
        alpha = alpha.point(lambda value: 0 if value < 64 else (255 if value >= 250 else value))
        image.putalpha(alpha)
        # 裁到可见人物范围，去掉透明底边。
        visible_alpha = alpha.point(lambda value: 255 if value >= 64 else 0)
        alpha_bbox = visible_alpha.getbbox()
        if alpha_bbox is not None:
            image = image.crop((0, 0, image.width, alpha_bbox[3]))
        target_h = int(self.config.get("size", 220))
        ratio = target_h / image.height
        target_w = max(80, int(image.width * ratio))
        self._sprite_image = image.resize((target_w, target_h), Image.Resampling.LANCZOS)
        # LANCZOS 会在显示尺寸重新生成半透明边缘；Tk 同样会把它混黑。
        # 在最终尺寸把 alpha 二值化，保留原图自带描边，不额外画边。
        display_alpha = self._sprite_image.getchannel("A").point(
            lambda value: 255 if value >= 128 else 0
        )
        self._sprite_image.putalpha(display_alpha)
        self._apply_sprite()

    def _apply_sprite(self) -> None:
        if self._sprite_image is None:
            return
        base = self._sprite_image
        window_w = max(BOARD_WIDTH, base.width, 240)
        if self.board_open:
            # 最终接缝：底条画在图片内部（人物图最下面 16px），
            # 不额外增加高度；人物像素盖在底条上，桌板从图片底边直接接上。
            image = Image.new("RGBA", (window_w, base.height), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle(
                (0, max(0, base.height - PET_SEAM_HEIGHT), window_w, base.height),
                fill=(0x5A, 0x49, 0x3B, 255),
            )
            image.alpha_composite(base, ((window_w - base.width) // 2, 0))
        else:
            image = Image.new("RGBA", (window_w, base.height), (0, 0, 0, 0))
            image.alpha_composite(base, ((window_w - base.width) // 2, 0))
        self._base_image = image
        self._photo = ImageTk.PhotoImage(image)
        self._pet_w = window_w
        self._pet_h = PET_MARGIN_TOP + image.height
        self._window_w = window_w
        self.pet_frame.configure(width=self._window_w, height=self._pet_h)
        self.pet_label.configure(image=self._photo, width=image.width, height=image.height)
        self.pet_label.place(
            x=0,
            y=PET_MARGIN_TOP,
            width=image.width,
            height=image.height,
        )
        self.board.configure(width=self._window_w)
        self._draw_badge()

    def _draw_badge(self) -> None:
        self.badge_label.place_forget()
        if not self.due_reminders:
            return
        x = self._window_w // 2 + min(110, self._pet_w // 4)
        y = PET_MARGIN + 12
        self.badge_label.configure(text=str(min(len(self.due_reminders), 9)))
        self.badge_label.place(x=x, y=y, anchor="ne")

    def _dpi_scale(self) -> float:
        """进程已在 main() 里声明 Per-Monitor DPI aware。

        Tk 的 geometry 与 winfo_screenheight 这时都使用真实像素，
        不再除以 Windows 的虚拟化比例 —— 除反了会把可用高度算小。
        """
        return 1.0

    def _screen_logical(self) -> tuple[float, float]:
        return (float(self.root.winfo_screenwidth()), float(self.root.winfo_screenheight()))

    def _init_position(self) -> None:
        sw, sh = self._screen_logical()
        x = self.state.get("x")
        y = self.state.get("y")
        if not isinstance(x, int) or not isinstance(y, int):
            # ⚠️ 默认放左上：右下常被 DSH 自己的桌宠/浏览器内容占住，
            # 首次启动放在那里会被误判为“桌宠没出现”。用户拖动后位置会记住。
            x = 40
            y = 110
        else:
            # 保存的位置可能来自更早的屏幕/缩放环境；窗口跑到屏幕外会把
            # 桌板文字裁掉（看起来像桌板坏了），启动时先钳回可见范围。
            x = max(0, min(x, int(sw - self._window_w)))
            y = max(0, min(y, int(sh - self._pet_h)))
        self.root.geometry(f"{self._window_w}x{self._pet_h}+{x}+{y}")
        self._x, self._y = x, y

    def _refresh_geometry(self) -> None:
        """保持顶部锚点；展开时向下长，收拢时向下缩。

        ⚠️ 高 DPI 必须用逻辑屏幕高度；否则输入框会落到物理屏幕外，
           看起来像“桌板没有输入”。
        """
        h = self._pet_h + (self._board_h if self.board_open else 0)
        _sw, logical_h = self._screen_logical()
        if self._y + h > logical_h - 8:
            self._y = int(max(8, logical_h - h - 8))
        self.root.geometry(f"{self._window_w}x{h}+{self._x}+{self._y}")
        if os.environ.get("PET_DEBUG_GEOM") == "1" and self.board_open:
            print(
                "BOARDDBG", "root", self.root.winfo_height(), "pet_h", self._pet_h,
                "board_y", self.board.winfo_y(), "board_h", self.board.winfo_height(),
                "body_y", self.body.winfo_y(), "body_h", self.body.winfo_height(),
                "input_y", self.input_frame.winfo_y(), "input_h", self.input_frame.winfo_height(),
                "status_y", self.status_label.winfo_y(), "status_h", self.status_label.winfo_height(),
                flush=True,
            )
        if os.environ.get("PET_DEBUG_GEOM") == "1" and self.board_open:
            print(
                "SEAMDBG",
                "root_h", self.root.winfo_height(),
                "pet_h", self._pet_h,
                "frame_h", self.pet_frame.winfo_height(),
                "label_y", self.pet_label.winfo_y(),
                "label_h", self.pet_label.winfo_height(),
                "label_rooty", self.pet_label.winfo_rooty(),
                "board_y", self.board.winfo_y(),
                "board_rooty", self.board.winfo_rooty(),
                "board_h", self.board.winfo_height(),
                flush=True,
            )

    def _set_board_height(self, target: int) -> None:
        # 桌板绝不能把输入框推到屏幕外；先按当前屏幕和人物高度算可用空间。
        _sw, logical_h = self._screen_logical()
        available = max(200, logical_h - self._pet_h - 24)
        target = max(0, min(BOARD_MAX_H, available, target))
        self._target_h = target
        self._animate_board()

    def _animate_board(self) -> None:
        if self._closing:
            return
        diff = self._target_h - self._board_h
        if abs(diff) <= 8:
            self._board_h = self._target_h
            if self.board_open:
                self.board.configure(height=max(1, self._board_h))
                self.board.pack(side="top", fill="x")
            else:
                self.board.pack_forget()
            self._refresh_geometry()
            return
        step = max(8, abs(diff) // 5)
        self._board_h += step if diff > 0 else -step
        self.board.configure(height=max(1, self._board_h))
        if self.board_open and not self.board.winfo_ismapped():
            self.board.pack(side="top", fill="x")
        self._refresh_geometry()
        self.root.after(16, self._animate_board)

    # ── 桌板 UI ─────────────────────────────────────────

    def _build_board(self) -> None:
        self.board.configure(width=self._window_w, height=1)
        self.board.pack_propagate(False)

        head = tk.Frame(self.board, bg=BOARD_BG_2, height=38)
        head.pack(side="top", fill="x")
        head.pack_propagate(False)
        tk.Label(
            head, text="管家", bg=BOARD_BG_2, fg=BOARD_TEXT,
            font=("Microsoft YaHei UI", 10, "bold"), anchor="w",
        ).pack(side="left", padx=14)
        self.header_hint = tk.Label(
            head, text="桌板 · 只显示阶段正文", bg=BOARD_BG_2, fg=BOARD_MUTED,
            font=("Microsoft YaHei UI", 8), anchor="w",
        )
        self.header_hint.pack(side="left", padx=4)
        tk.Button(
            head, text="收起", command=self.toggle_board,
            bg=BOARD_BG_2, fg=BOARD_MUTED, activebackground=BOARD_BG_2,
            activeforeground=BOARD_TEXT, relief="flat", bd=0,
            font=("Microsoft YaHei UI", 8), cursor="hand2",
        ).pack(side="right", padx=8)

        self.reminder_bar = tk.Frame(self.board, bg="#6a4a34")
        self.reminder_label = tk.Label(
            self.reminder_bar, text="", bg="#6a4a34", fg="#ffe4b8",
            font=("Microsoft YaHei UI", 9), anchor="w", justify="left",
        )
        self.reminder_label.pack(side="left", padx=12, pady=6)
        tk.Button(
            self.reminder_bar, text="去处理", command=self._open_tasks,
            bg="#6a4a34", fg="#ffe4b8", activebackground="#6a4a34",
            activeforeground="#fff4df", relief="flat", bd=0,
            font=("Microsoft YaHei UI", 8, "underline"), cursor="hand2",
        ).pack(side="right", padx=10)
        # 默认不显示；有到期提醒时才 pack

        body = tk.Frame(self.board, bg=BOARD_BG)
        self.body = body
        body.pack(side="top", fill="both", expand=True, padx=12, pady=(8, 4))
        body.grid_rowconfigure(0, weight=1)
        body.grid_columnconfigure(0, weight=1)

        text_wrap = tk.Frame(body, bg=BOARD_BG)
        text_wrap.grid(row=0, column=0, sticky="nsew")
        text_wrap.grid_rowconfigure(0, weight=1)
        text_wrap.grid_columnconfigure(0, weight=1)
        self.output = tk.Text(
            text_wrap, height=7, width=42, wrap="word",
            bg=BOARD_BG, fg=BOARD_TEXT, insertbackground=BOARD_TEXT,
            relief="flat", bd=0, padx=2, pady=2,
            font=("Microsoft YaHei UI", 10), spacing1=2, spacing3=6,
            selectbackground="#6f5a48",
        )
        self.output.grid(row=0, column=0, sticky="nsew")
        self.output.configure(state="disabled")
        self.scrollbar = tk.Scrollbar(
            text_wrap, orient="vertical", command=self.output.yview,
            width=8, bg=BOARD_BG_2, troughcolor=BOARD_BG,
            activebackground=BOARD_MUTED, relief="flat", bd=0,
        )
        self.scrollbar.grid(row=0, column=1, sticky="ns", padx=(4, 0))
        self.output.configure(yscrollcommand=self.scrollbar.set)

        self.status_label = tk.Label(
            self.board, text="输入内容，Enter 发送", bg=BOARD_BG, fg=BOARD_MUTED,
            font=("Microsoft YaHei UI", 8), anchor="w",
        )
        self.status_label.pack(side="top", fill="x", padx=14)

        input_frame = tk.Frame(self.board, bg=BOARD_BG_2)
        self.input_frame = input_frame
        input_frame.pack(side="bottom", fill="x", padx=8, pady=8)
        self.input = tk.Text(
            input_frame, height=2, wrap="word", bg="#f7efe3", fg="#3d3028",
            insertbackground="#3d3028", relief="flat", bd=0,
            padx=8, pady=6, font=("Microsoft YaHei UI", 10),
        )
        self.input.bind("<Return>", self._on_enter)
        self.input.bind("<Shift-Return>", lambda _e: None)
        self.input.bind("<Button-1>", lambda _e: self.input.focus_set(), add="+")
        # 先给右侧按钮留出空间，再让输入框吃掉剩余宽度；
        # 反过来 pack 会把按钮挤出可视区（真实布局回归）。
        button_col = tk.Frame(input_frame, bg=BOARD_BG_2)
        button_col.pack(side="right", padx=(6, 4))
        self.file_btn = tk.Button(
            button_col, text="文件", command=self._pick_files,
            bg=BOARD_BG_2, fg=BOARD_MUTED, activebackground=BOARD_BG_2,
            activeforeground=BOARD_TEXT, relief="flat", bd=0,
            font=("Microsoft YaHei UI", 9), cursor="hand2",
        )
        self.file_btn.pack(side="top", pady=(0, 4))
        self.send_btn = tk.Button(
            button_col, text="发送", command=self._send,
            bg=BOARD_ACCENT, fg="#1d3324", activebackground="#b4d8b9",
            activeforeground="#1d3324", relief="flat", bd=0, padx=10,
            font=("Microsoft YaHei UI", 9, "bold"), cursor="hand2",
        )
        self.send_btn.pack(side="top")
        self.input.pack(side="left", fill="both", expand=True)

        # ⚠️ pack 的分配顺序很重要：body 先 pack 且 expand=True 会吃掉剩余空间，
        # 后 pack 的 input/status 可能被挤到窗口外（真实布局回归）。
        # 重新按“底部输入区 → 底部状态 → 剩余正文”的顺序 pack。
        self.input_frame.pack_forget()
        self.status_label.pack_forget()
        self.body.pack_forget()
        self.input_frame.pack(side="bottom", fill="x", padx=8, pady=8)
        self.status_label.pack(side="bottom", fill="x", padx=14)
        self.body.pack(side="top", fill="both", expand=True, padx=12, pady=(8, 4))
        # 明确抬升底部输入区，避免任何 pack/重排顺序把它压到正文下面。
        self.input_frame.lift()
        self.status_label.lift()

    def _bind_pet(self) -> None:
        for widget in (self.pet_frame, self.pet_label, self.badge_label):
            widget.bind("<ButtonPress-1>", self._on_pet_press)
            widget.bind("<B1-Motion>", self._on_pet_drag)
            widget.bind("<ButtonRelease-1>", self._on_pet_release)
            widget.bind("<Button-3>", self._on_context_menu)
        self.board.bind("<Button-3>", self._on_context_menu)

    # ── 拖动 / 点击 ─────────────────────────────────────

    def _on_pet_press(self, event: tk.Event) -> None:
        self._drag = {
            "x": event.x_root,
            "y": event.y_root,
            "wx": self._x,
            "wy": self._y,
            "moved": False,
        }

    def _on_pet_drag(self, event: tk.Event) -> None:
        if self._drag is None:
            return
        dx = event.x_root - self._drag["x"]
        dy = event.y_root - self._drag["y"]
        if abs(dx) + abs(dy) > 5:
            self._drag["moved"] = True
        self._x = self._drag["wx"] + dx
        self._y = self._drag["wy"] + dy
        self.root.geometry(f"{self._window_w}x{self._pet_h + (self._board_h if self.board_open else 0)}+{self._x}+{self._y}")

    def _on_pet_release(self, _event: tk.Event) -> None:
        moved = bool(self._drag and self._drag.get("moved"))
        self._drag = None
        self.state["x"] = self._x
        self.state["y"] = self._y
        save_state(self.state)
        if not moved:
            self.toggle_board()

    def _on_context_menu(self, event: tk.Event) -> None:
        menu = tk.Menu(self.root, tearoff=0, bg="#f7efe3", fg="#3d3028", activebackground="#e3d6c5")
        model_menu = tk.Menu(menu, tearoff=0, bg="#f7efe3", fg="#3d3028", activebackground="#e3d6c5")
        model_menu.add_command(
            label="跟随主界面当前模型" + ("  ✓" if self.config.get("model") is None else ""),
            command=lambda: self._set_model(None),
        )
        if self.model_loading:
            model_menu.add_command(label="正在读取模型…", state="disabled")
        elif self.model_options:
            model_menu.add_separator()
            current = self.config.get("model") or {}
            for option in self.model_options:
                selected = (
                    current.get("profileId") == option["profileId"]
                    and current.get("modelId") == option["modelId"]
                )
                model_menu.add_command(
                    label=option["label"] + ("  ✓" if selected else ""),
                    command=lambda o=option: self._set_model(o),
                )
        else:
            model_menu.add_command(label="没有可用的对话模型", state="disabled")
        menu.add_cascade(label="模型与思考强度", menu=model_menu)
        think_menu = tk.Menu(menu, tearoff=0, bg="#f7efe3", fg="#3d3028", activebackground="#e3d6c5")
        labels = {"default": "默认", "low": "低", "medium": "中", "high": "高"}
        for value, label in labels.items():
            think_menu.add_command(
                label=label + ("  ✓" if self.config.get("thinkingLevel") == value else ""),
                command=lambda v=value: self._set_thinking(v),
            )
        model_menu.add_separator()
        model_menu.add_cascade(label="思考强度（后端暂未接入）", menu=think_menu)
        menu.add_separator()
        menu.add_command(label="打开主界面", command=self._open_main)
        menu.add_command(label="定时任务", command=self._open_tasks)
        menu.add_command(
            label=("始终置顶  ✓" if self.config.get("alwaysOnTop", True) else "始终置顶"),
            command=self._toggle_topmost,
        )
        menu.add_command(label="隐藏桌宠", command=self._hide)
        menu.add_separator()
        menu.add_command(label="退出桌宠", command=self._quit)
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    # ── 桌板 ────────────────────────────────────────────

    def toggle_board(self) -> None:
        self.board_open = not self.board_open
        self._apply_sprite()
        self._refresh_geometry()
        if self.board_open:
            self.board.pack(side="top", fill="x")
            self._set_board_height(BOARD_MIN_H)
            self.root.after(250, self._focus_input)
            self._render_output()
            self._grow_for_content()
        else:
            self._set_board_height(0)

    def _focus_input(self) -> None:
        try:
            self.root.focus_force()
            self.input.focus_set()
            self._force_topmost()
        except Exception:
            pass

    def _render_output(self) -> None:
        if not hasattr(self, "blocks"):
            self.blocks: list[dict[str, Any]] = []
        self.output.configure(state="normal")
        self.output.delete("1.0", "end")
        for block in self.blocks:
            if block["kind"] == "user":
                self.output.insert("end", "你：", "user_tag")
                self.output.insert("end", block["text"] + "\n\n", "user_text")
            elif block["kind"] == "stage":
                self.output.insert("end", block["text"] + "\n\n", "stage")
            else:
                self.output.insert("end", block["text"] + "\n\n", "final")
        self.output.tag_configure("user_tag", foreground=BOARD_ACCENT, font=("Microsoft YaHei UI", 9, "bold"))
        self.output.tag_configure("user_text", foreground=BOARD_MUTED)
        self.output.tag_configure("stage", foreground=BOARD_TEXT, font=("Microsoft YaHei UI", 10))
        self.output.tag_configure("final", foreground="#fff8ec", font=("Microsoft YaHei UI", 10, "bold"))
        self.output.configure(state="disabled")
        self.output.see("end")

    def _ensure_blocks(self) -> None:
        if not hasattr(self, "blocks"):
            self.blocks: list[dict[str, Any]] = []
        if not hasattr(self, "current_stage"):
            self.current_stage: dict[str, Any] | None = None

    def _append_block(self, kind: str, text: str) -> dict[str, Any]:
        self._ensure_blocks()
        block = {"kind": kind, "text": text}
        self.blocks.append(block)
        self._grow_for_content()
        self._render_output()
        return block

    def _grow_for_content(self) -> None:
        if not self.board_open:
            return
        lines = sum(max(1, b["text"].count("\n") + 1) for b in getattr(self, "blocks", []))
        _sw, logical_h = self._screen_logical()
        available = max(BOARD_MIN_H, logical_h - self._pet_h - 24)
        target = max(BOARD_MIN_H, min(BOARD_MAX_H, available, 170 + lines * 22))
        if abs(target - self._target_h) > 20:
            self._set_board_height(target)

    def _append_stage(self, round_no: int, text: str) -> None:
        self._ensure_blocks()
        if self.current_stage is None or self.current_stage.get("round") != round_no:
            self.current_stage = {"kind": "stage", "round": round_no, "text": text}
            self.blocks.append(self.current_stage)
        else:
            self.current_stage["text"] = text
        self._grow_for_content()
        self._render_output()

    def _finish_stage(self) -> None:
        if getattr(self, "current_stage", None) is not None:
            self.current_stage = None

    def _on_enter(self, event: tk.Event) -> str | None:
        if event.state & 0x0001:  # Shift
            return None
        self._send()
        return "break"

    def _pick_files(self) -> None:
        paths = filedialog.askopenfilenames(
            title="选择参考文件",
            filetypes=[("文本文件", "*.txt *.md *.json *.csv *.log *.py *.ts *.js"), ("所有文件", "*.*")],
        )
        if not paths:
            return
        chunks: list[str] = []
        for raw in paths[:5]:
            try:
                data = Path(raw).read_text(encoding="utf-8", errors="replace")
                chunks.append(f"\n\n【参考文件 {Path(raw).name}】\n{data[:30000]}")
            except Exception as err:
                chunks.append(f"\n\n【参考文件 {Path(raw).name} 读取失败】{err}")
        self.input.insert("end", "".join(chunks))

    def _send(self) -> None:
        if self.streaming:
            return
        text = self.input.get("1.0", "end-1c").strip()
        if not text:
            return
        self._ensure_blocks()
        self.input.delete("1.0", "end")
        self.blocks.append({"kind": "user", "text": text})
        if self._target_h < BOARD_MIN_H:
            self._set_board_height(BOARD_MIN_H)
        self.current_stage = None
        self.streaming = True
        self.cancel_event = threading.Event()
        self.send_btn.configure(state="disabled", text="…")
        self.status_label.configure(text="正在思考ing…", fg=BOARD_ACCENT)
        self._grow_for_content()
        self._render_output()

        def worker() -> None:
            try:
                with self._session_lock:
                    sid = ensure_session(self.state)
                stream_chat(
                    text, sid, self.config,
                    lambda event: self.events.put(("chat", event)),
                    self.cancel_event,
                )
                self.events.put(("chat_done", None))
            except Exception as err:
                self.events.put(("chat_error", str(err)))

        self.worker = threading.Thread(target=worker, daemon=True)
        self.worker.start()

    # ── 事件队列（Tk 主线程消费）────────────────────────

    def _drain_events(self) -> None:
        if self._closing:
            return
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "chat":
                    self._handle_chat_event(payload)
                elif kind == "chat_done":
                    self._on_chat_done()
                elif kind == "chat_error":
                    self._on_chat_error(str(payload))
                elif kind == "tasks":
                    self.due_reminders = payload
                    self._update_reminders()
                    self._draw_badge()
                elif kind == "models":
                    self.model_options = payload
                    self.model_loading = False
                elif kind == "config":
                    cfg = normalize_config(payload)
                    sprite_changed = cfg.get("sprite") != self.config.get("sprite")
                    size_changed = cfg.get("size") != self.config.get("size")
                    was_enabled = bool(self.config.get("enabled", True))
                    self.config = cfg
                    self._apply_topmost()
                    if not cfg.get("enabled", True):
                        # 设置页关掉后保留进程与提醒轮询，再次打开可恢复；
                        # 不直接退出，避免“关一个开关=杀进程”的隐性行为。
                        if self.root.state() != "withdrawn":
                            self.root.withdraw()
                    elif not was_enabled:
                        self.root.deiconify()
                        self._force_topmost()
                    if sprite_changed or size_changed:
                        self._load_sprite()
                        self._refresh_geometry()
                elif kind == "show":
                    self._show()
                elif kind == "quit":
                    self._quit()
        except queue.Empty:
            pass
        self.root.after(80, self._drain_events)

    def _handle_chat_event(self, event: dict[str, Any]) -> None:
        if not isinstance(event, dict):
            return
        typ = event.get("type")
        if typ == "session" and isinstance(event.get("sessionId"), str):
            self.state["sessionId"] = event["sessionId"]
            save_state(self.state)
        elif typ == "agent":
            kind = event.get("kind")
            if kind == "text":
                text = event.get("accumulated")
                if isinstance(text, str) and text.strip():
                    self._append_stage(int(event.get("round") or 0), text.strip())
                    self.status_label.configure(text="继续思考ing…", fg=BOARD_ACCENT)
            elif kind in ("toolCall", "toolStarted", "toolResult"):
                # 不显示工具细节；只把当前阶段封存，下一轮正文是新的阶段。
                # 如果工具看起来会动电脑，桌板只显示“正在操作电脑”，
                # 不显示命令、参数或结果；Esc 仍可请求停止本轮。
                name = str(event.get("name") or "")
                self._finish_stage()
                if self.streaming:
                    if any(part in name.lower() for part in (
                        "desktop", "exec", "command", "write_file", "remove_path", "move_path",
                    )):
                        self.status_label.configure(text="正在操作电脑 · Esc 停止", fg=BOARD_WARN)
                    else:
                        self.status_label.configure(text="继续思考ing…", fg=BOARD_ACCENT)
            elif kind == "reasoning":
                # 思考正文一律不显示。
                pass
        elif typ == "reply":
            text = event.get("text")
            if isinstance(text, str) and text.strip():
                self._ensure_blocks()
                # 最终回复可能与最后一轮 agent.text 相同，避免重复。
                last_stage = self.current_stage or (self.blocks[-1] if self.blocks else None)
                last_text = last_stage.get("text") if isinstance(last_stage, dict) else None
                if last_text != text.strip():
                    self.blocks.append({"kind": "final", "text": text.strip()})
                else:
                    last_stage["kind"] = "final"
                self._finish_stage()
                self._grow_for_content()
                self._render_output()
        elif typ == "approval":
            # 第一版声明了 supportsApproval:false，理论上不会来；来了也不静默。
            self.status_label.configure(text="需要确认的动作已被拒绝（桌宠暂不处理审批）", fg=BOARD_WARN)
        elif typ == "error":
            self._on_chat_error(str(event.get("error") or "对话失败"))

    def _on_chat_done(self) -> None:
        if not self.streaming:
            return
        self.streaming = False
        self.send_btn.configure(state="normal", text="发送")
        if "已完成" not in self.status_label.cget("text"):
            self.status_label.configure(text="已完成", fg=BOARD_ACCENT)
        self._render_output()

    def _on_chat_error(self, message: str) -> None:
        self.streaming = False
        self.send_btn.configure(state="normal", text="发送")
        self.status_label.configure(text=f"失败：{message[:120]}", fg=BOARD_WARN)
        self._render_output()

    def _on_escape(self, _event: tk.Event) -> None:
        if self.streaming:
            self.cancel_event.set()
            self.status_label.configure(text="正在停止…", fg=BOARD_WARN)
        elif self.board_open:
            self.toggle_board()

    # ── 提醒 / 配置 / 模型 ───────────────────────────────

    def _poll_tasks(self) -> None:
        if self._closing:
            return
        def worker() -> None:
            try:
                data = api_json("GET", "/api/tasks", None, timeout=15)
                tasks = data.get("tasks") if isinstance(data, dict) else []
                due = [
                    t for t in (tasks or [])
                    if isinstance(t, dict) and t.get("kind") == "reminder"
                    and t.get("status") == "active" and t.get("due") is True
                ]
                self.events.put(("tasks", due))
            except Exception:
                pass
        threading.Thread(target=worker, daemon=True).start()
        self.root.after(POLL_MS, self._poll_tasks)

    def _update_reminders(self) -> None:
        if self.due_reminders:
            names = "、".join(str(t.get("title", "提醒")) for t in self.due_reminders[:3])
            more = " 等" if len(self.due_reminders) > 3 else ""
            self.reminder_label.configure(text=f"提醒：{names}{more}")
            if not self.reminder_bar.winfo_ismapped():
                self.reminder_bar.pack(side="top", fill="x", after=self.board.winfo_children()[0])
            self.header_hint.configure(text=f"{len(self.due_reminders)} 条提醒")
        else:
            self.reminder_bar.pack_forget()
            self.header_hint.configure(text="桌板 · 只显示阶段正文")

    def _poll_config(self) -> None:
        if self._closing:
            return
        def worker() -> None:
            try:
                data = api_json("GET", "/api/pet/config", None, timeout=15)
                self.events.put(("config", data.get("config")))
            except Exception:
                pass
        threading.Thread(target=worker, daemon=True).start()
        self.root.after(CONFIG_POLL_MS, self._poll_config)

    def _refresh_models(self) -> None:
        if self.model_loading:
            return
        self.model_loading = True
        def worker() -> None:
            try:
                data = api_json("GET", "/api/model", None, timeout=20)
                options: list[dict[str, str]] = []
                for profile in data.get("profiles", []) if isinstance(data, dict) else []:
                    if not isinstance(profile, dict):
                        continue
                    for model in profile.get("models", []) or []:
                        if isinstance(model, dict) and model.get("kind") == "chat":
                            options.append({
                                "profileId": str(profile.get("id", "")),
                                "modelId": str(model.get("id", "")),
                                "label": f"{profile.get('name', profile.get('id', ''))} · {model.get('id', '')}",
                            })
                self.events.put(("models", options))
            except Exception:
                self.events.put(("models", []))
        threading.Thread(target=worker, daemon=True).start()

    def _set_model(self, option: dict[str, str] | None) -> None:
        self.config["model"] = None if option is None else {
            "profileId": option["profileId"],
            "modelId": option["modelId"],
            "label": option["label"],
        }
        save_local_config(self.config)
        def worker() -> None:
            try:
                api_json("PUT", "/api/pet/config", {"model": self.config["model"]}, timeout=15)
            except Exception:
                pass
        threading.Thread(target=worker, daemon=True).start()
        self.status_label.configure(text="模型偏好已保存", fg=BOARD_ACCENT)

    def _set_thinking(self, value: str) -> None:
        self.config["thinkingLevel"] = value
        save_local_config(self.config)
        threading.Thread(
            target=lambda: self._safe_put({"thinkingLevel": value}), daemon=True
        ).start()
        self.status_label.configure(
            text="思考强度偏好已保存；当前聊天后端暂未接入", fg=BOARD_WARN
        )

    def _safe_put(self, body: dict[str, Any]) -> None:
        try:
            api_json("PUT", "/api/pet/config", body, timeout=15)
        except Exception:
            pass

    def _apply_topmost(self) -> None:
        try:
            enabled = bool(self.config.get("alwaysOnTop", True))
            self.root.attributes("-topmost", enabled)
            if enabled:
                self.root.lift()
                self._force_topmost()
        except Exception:
            pass

    def _force_topmost(self) -> None:
        """Tk 的 -topmost 在 overrideredirect 窗口上有时不生效，补一次 Win32。

        ⚠️ winfo_id 在 Tk 里可能是内层窗口；必须用 GetAncestor(GA_ROOT)
           对真正的顶层 wrapper 设置 z-order，否则样式是 topmost、实际仍被
           浏览器窗口压住。
        """
        try:
            enabled = bool(self.config.get("alwaysOnTop", True))
            if sys.platform != "win32":
                return
            user32 = ctypes.windll.user32
            hwnd = int(self.root.winfo_id())
            root_hwnd = user32.GetAncestor(hwnd, 2)  # GA_ROOT
            target = root_hwnd or hwnd
            HWND_TOPMOST = -1
            HWND_NOTOPMOST = -2
            SWP_NOMOVE = 0x0002
            SWP_NOSIZE = 0x0001
            SWP_NOACTIVATE = 0x0010
            SWP_SHOWWINDOW = 0x0040
            user32.SetWindowPos(
                target,
                HWND_TOPMOST if enabled else HWND_NOTOPMOST,
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            # 不抢焦点，只把窗口提到同层最前。
            user32.BringWindowToTop(target)
            self.root.lift()
        except Exception:
            pass

    def _keep_topmost(self) -> None:
        if self._closing:
            return
        if self.config.get("alwaysOnTop", True):
            self._force_topmost()
        self.root.after(3000, self._keep_topmost)

    def _toggle_topmost(self) -> None:
        self.config["alwaysOnTop"] = not bool(self.config.get("alwaysOnTop", True))
        self._apply_topmost()
        save_local_config(self.config)
        threading.Thread(
            target=lambda: self._safe_put({"alwaysOnTop": self.config["alwaysOnTop"]}),
            daemon=True,
        ).start()

    # ── 托盘 / 隐藏 / 退出 ───────────────────────────────

    def _setup_tray(self) -> None:
        try:
            import pystray
        except Exception as err:
            self._tray_icon = None
            self._tray_error = f"import: {err}"
            return
        try:
            image = Image.open(self._sprite_path()).convert("RGBA")
            image.thumbnail((64, 64))
            def show(_icon: Any = None, _item: Any = None) -> None:
                self.events.put(("show", None))
            def quit_(_icon: Any = None, _item: Any = None) -> None:
                self.events.put(("quit", None))
            menu = pystray.Menu(
                pystray.MenuItem("显示桌宠", show, default=True),
                pystray.MenuItem("打开主界面", lambda *_: webbrowser.open(f"{BASE_URL}/#/chat")),
                pystray.MenuItem("退出桌宠", quit_),
            )
            self._tray_icon = pystray.Icon("butler-pet", image, "butler 桌宠", menu)
            self._tray_thread = threading.Thread(target=self._tray_icon.run, daemon=True)
            self._tray_thread.start()
        except Exception as err:
            self._tray_icon = None
            self._tray_error = str(err)

    def _hide(self) -> None:
        if self._tray_icon is None:
            # 没有托盘时不假装能隐藏：直接提示，避免用户把窗口弄丢。
            self.status_label.configure(text=f"系统托盘不可用，无法安全隐藏 {self._tray_error[:40]}", fg=BOARD_WARN)
            return
        self.state["hidden"] = True
        save_state(self.state)
        self.root.withdraw()
        try:
            self._tray_icon.notify("butler 桌宠已隐藏，可从托盘恢复", "butler")
        except Exception:
            pass

    def _show(self) -> None:
        self.state["hidden"] = False
        save_state(self.state)
        try:
            if self._tray_icon is not None:
                self._tray_icon.stop()
                self._tray_icon = None
        except Exception:
            pass
        self.root.deiconify()
        self.root.lift()
        self.root.attributes("-topmost", bool(self.config.get("alwaysOnTop", True)))
        self._refresh_geometry()
        self._setup_tray()

    def _open_main(self) -> None:
        webbrowser.open(f"{BASE_URL}/#/chat")

    def _open_tasks(self) -> None:
        webbrowser.open(f"{BASE_URL}/#/tasks")

    def _quit(self) -> None:
        if self._closing:
            return
        self._closing = True
        self.cancel_event.set()
        try:
            self.state["x"] = self._x
            self.state["y"] = self._y
            save_state(self.state)
        except Exception:
            pass
        try:
            if self._tray_icon is not None:
                self._tray_icon.stop()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass


def main() -> None:
    # ⚠️ 必须在创建 Tk 之前声明 DPI aware；否则 Windows 会把窗口
    # 按 125% 虚拟化，Tk 算出的底部与截图像素对不上，输入框会掉到屏幕外。
    if sys.platform == "win32":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass

    parser = argparse.ArgumentParser(description="butler desktop pet")
    parser.add_argument("--no-tray", action="store_true", help="不创建系统托盘")
    args = parser.parse_args()
    if args.no_tray:
        # 目前托盘是隐藏功能的唯一安全恢复入口；此参数保留给无托盘环境调试。
        pass

    lock = acquire_instance_lock()
    if lock is None:
        # 第二个实例（双击 .bat 或设置页重复点击）直接安静退出；
        # 设置页通过 PID/进程存活显示“正在运行”，不会叠出第二只。
        print("butler 桌宠已在运行", file=sys.stderr)
        raise SystemExit(0)
    atexit.register(release_instance_lock, lock)

    try:
        root = tk.Tk()
    except Exception as err:
        release_instance_lock(lock)
        print(f"无法创建 Tk 窗口：{err}", file=sys.stderr)
        raise SystemExit(2)
    try:
        PetApp(root)
    except Exception as err:
        messagebox.showerror("butler 桌宠", str(err))
        release_instance_lock(lock)
        raise SystemExit(1)
    try:
        root.mainloop()
    finally:
        release_instance_lock(lock)


if __name__ == "__main__":
    main()
