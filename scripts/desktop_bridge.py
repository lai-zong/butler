#!/usr/bin/env python3
"""管家式 AI · 桌面控制桥（Python sidecar）

★ 为什么是**长驻进程**而不是每次 `python -c`：
  桌面操作天然是**连续多步**（列窗口 → 截图 → 操作）。
  每次调用付 200—400ms 启动开销，几步下来就迟滞到用户能感觉到。
  这里常驻一个进程，每次请求只是一行 JSON。

★ 协议（行分隔 JSON，UTF-8 显式）：
   stdin  每行：{"id": "r1", "op": "office_convert", "args": {...}}
   stdout 每行：{"id": "r1", "ok": true, "result": {...}}
                或 {"id": "r1", "ok": false, "error": "..."}
   stderr 只放日志 —— **绝不能往 stdout 打任何非协议内容**，
          否则 Node 侧解析会当场失败。

⚠️ 三点必须守住的工程约束（都在实测里踩过）：
   ① 中文必须显式 UTF-8：Windows 控制台默认 GBK，会把"版本"打成乱码
   ② Office COM 必须 `Visible=False` + `DisplayAlerts=0`：否则 Word 弹一个
      "是否保存"对话框，整个调用挂死
   ③ 每个请求独立 try/except：一个操作失败不能带崩整个进程

★ 三级能力（方案 §9）：只用前两层，视觉层（截图）单独一个 op。
   ① COM（应用接口）—— office_convert
   ② UIA（无障碍）—— list_windows
   ③ 视觉 —— screenshot
"""

import json
import os
import sys
import tempfile
import time
import traceback

# ⚠️ 显式 UTF-8：Windows 默认 GBK，中文输出会乱码
try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # 老版本 Python 没有 reconfigure
    pass


def log(*parts):
    """日志只走 stderr —— stdout 属于协议。"""
    print("[bridge]", *parts, file=sys.stderr, flush=True)


# ═══════════════════════════════════════════════════════════
# ③ 视觉层：截图
# ═══════════════════════════════════════════════════════════

def op_screenshot(_args):
    """截全屏并保存为 PNG，返回文件路径。

    ⚠️ 优先用 mss（快 3—10 倍、支持多显示器）；
       没有 mss 时退回 PIL.ImageGrab。
    """
    out_dir = os.path.join(tempfile.gettempdir(), "butler-shots")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"shot-{int(time.time() * 1000)}.png")

    try:
        import mss  # type: ignore
        import mss.tools  # type: ignore

        with mss.mss() as sct:
            monitor = sct.monitors[0]  # 0 = 所有显示器合并
            raw = sct.grab(monitor)
            mss.tools.to_png(raw.rgb, raw.size, output=path)
        return {"path": path, "backend": "mss", "width": raw.size[0], "height": raw.size[1]}
    except Exception as mss_err:
        log("mss 不可用，退回 PIL.ImageGrab：", mss_err)
        from PIL import ImageGrab  # type: ignore

        img = ImageGrab.grab()
        img.save(path, "PNG")
        return {"path": path, "backend": "pil", "width": img.width, "height": img.height}


# ═══════════════════════════════════════════════════════════
# ① COM 层：Office 文档转 PDF（方案 §9.2 的演示场景）
# ═══════════════════════════════════════════════════════════

# Word 的 SaveAs 格式常量：wdFormatPDF = 17
WD_FORMAT_PDF = 17


def op_office_convert(args):
    """用 Word COM 把 .docx/.doc 转成 PDF。

    ★ 为什么这条路径稳：它走的是 **Word 自己的接口**，
      不是"截图找菜单点导出"。Word 在后台干活，全程不弹窗。

    ⚠️ 三个必须做的防御：
       · Visible=False —— 不把 Word 窗口弹到用户面前
       · DisplayAlerts=0 —— 不让它弹"是否保存"（弹了就挂死）
       · finally 里 Quit + 释放 —— 否则 Word 进程会残留，下次 Dispatch 拿到旧实例
    """
    src = args.get("source")
    dst = args.get("target")
    if not isinstance(src, str) or not os.path.isfile(src):
        raise FileNotFoundError(f"源文件不存在：{src}")
    if not isinstance(dst, str) or len(dst) == 0:
        raise ValueError("缺少 target")
    if not dst.lower().endswith(".pdf"):
        raise ValueError("target 必须是 .pdf")

    import win32com.client  # type: ignore

    word = None
    doc = None
    try:
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False          # 不弹窗
        word.DisplayAlerts = 0        # 不弹任何确认框

        # ReadOnly=True：不修改源文件，也不会因为"文件被占用"而失败
        doc = word.Documents.Open(os.path.abspath(src), ReadOnly=True, AddToRecentFiles=False)
        doc.SaveAs(os.path.abspath(dst), FileFormat=WD_FORMAT_PDF)
        return {
            "source": os.path.abspath(src),
            "target": os.path.abspath(dst),
            "bytes": os.path.getsize(dst) if os.path.isfile(dst) else 0,
        }
    finally:
        # ⚠️ 顺序不能反：先关文档再退应用
        try:
            if doc is not None:
                doc.Close(SaveChanges=0)  # 0 = 不保存
        except Exception:
            pass
        try:
            if word is not None:
                word.Quit()
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════
# ② UIA 层：列出窗口（只读）
# ═══════════════════════════════════════════════════════════

def op_list_windows(args):
    """列出当前顶层窗口（标题 / 类名 / 进程 id）。

    ⚠️ 用 UIA 的控件语义而不是像素 —— 分辨率/语言/主题变了它也还认得。
    """
    limit = args.get("limit", 40)
    limit = int(limit) if isinstance(limit, (int, float)) else 40

    import uiautomation as auto  # type: ignore

    root = auto.GetRootControl()
    out = []
    for child in root.GetChildren():
        try:
            name = child.Name or ""
            cls = child.ClassName or ""
            pid = child.ProcessId
        except Exception:
            continue
        if not name and not cls:
            continue
        out.append({"title": name, "className": cls, "processId": pid})
        if len(out) >= limit:
            break

    return {"windows": out, "count": len(out)}


# ═══════════════════════════════════════════════════════════
# 能力探测（Node 侧据此决定注册哪些工具）
# ═══════════════════════════════════════════════════════════

def op_ping(_args):
    """报告本机到底能用哪些能力。

    ★ 这个 op 存在的意义：**不猜**。
      Node 侧不去假设"装了 Python 就有 win32com"，
      而是问一次，按回包决定注册哪些工具。
    """
    caps = {}
    for mod in ("win32com", "uiautomation", "mss", "pyautogui", "PIL"):
        try:
            __import__(mod)
            caps[mod] = True
        except Exception:
            caps[mod] = False
    return {"python": sys.version.split()[0], "platform": sys.platform, "capabilities": caps}


OPS = {
    "ping": op_ping,
    "list_windows": op_list_windows,
    "office_convert": op_office_convert,
    "screenshot": op_screenshot,
}


def main():
    log("bridge 启动，pid", os.getpid())
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            op = req.get("op")
            args = req.get("args") or {}
            fn = OPS.get(op)
            if fn is None:
                raise ValueError(f"未知 op：{op}")
            result = fn(args)
            resp = {"id": req_id, "ok": True, "result": result}
        except Exception as e:
            # ⚠️ 单个请求失败不能带崩进程 —— 把异常变成一条错误响应
            resp = {"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"}
            log("op 失败：", traceback.format_exc(limit=3))

        # 逐行输出并强制 flush —— Node 侧是按行读的，缓冲会让它一直等
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
