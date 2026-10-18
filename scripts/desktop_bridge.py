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

# ⚠️ 模块级导入（不能只在某个 op 里局部导入）：
#   加了 uia_* 之后，多个 op 都要用它；局部导入会让别的 op 报 NameError。
#    第一版就是局部导入，加完新 op 后 4 个 uia_* 全部 `NameError: name 'auto' is not defined`。
#    ⚠️ 缺这个模块时**如实标注**，由各 op 抛明确错误，而不是让整个桥起不来。
try:
    import uiautomation as auto  # type: ignore
except Exception as _uia_err:  # pragma: no cover
    auto = None  # type: ignore
    _UIA_IMPORT_ERROR = _uia_err
else:
    _UIA_IMPORT_ERROR = None


def _require_uia():
    """用到 UIA 的 op 先过这一道，缺依赖时给出可执行的提示。"""
    if auto is None:
        raise RuntimeError(
            f"uiautomation 不可用（{_UIA_IMPORT_ERROR}）。请先 pip install uiautomation"
        )
    return auto

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


# ⚠️ `OPS` 必须定义在**所有 op 函数之后** —— 否则模块加载时 NameError
#    （第一版把它放在中间，加了 uia_* 之后就崩在导入阶段，一行响应都发不出来）


# ═══════════════════════════════════════════════════════════
# ② UIA 层：按**元素**操作（不按坐标）
# ═══════════════════════════════════════════════════════════
#
# ★★ 为什么这一层是重点（实测证据）：
#   操作 Windows 设置时，全程**没有一个坐标点击** ——
#   导航项用 `SelectionItemPattern.Select()`、开关用 `TogglePattern.Toggle()`，
#   于是**即使窗口被别的窗口挡住、甚至不在前台，操作照样生效**。
#
#   反例（同一台机器）：酷狗是自绘 UI（类名 `kugou_ui`），
#   `ValuePattern.SetValue` 抛 COMError、合成键盘事件也不进输入框，
#   只能靠坐标点击 —— 而坐标点击在有叠加窗口时会**打错目标**（实测踩到过）。
#
#   → 所以这一层要**优先模式、明确拒绝猜测**，而不是"找不到就点坐标"。
#
# ⚠️ 三条纪律：
#   ① **多个匹配就拒绝** —— 同名控件可能有很多个，猜一个等于乱点
#   ② **每次操作后必须读回状态** —— "点了然后祈祷"不是可验证的操作
#   ③ **如实报告失败** —— 模式不支持就说"不支持"，不要退化成坐标点击

# 控件类型友好名 → UIA 类名
CONTROL_TYPES = {
    "button": "ButtonControl",
    "listitem": "ListItemControl",
    "tab": "TabItemControl",
    "tabitem": "TabItemControl",
    "edit": "EditControl",
    "toggle": "ButtonControl",       # WinUI 的 ToggleSwitch 报成 Button
    "checkbox": "CheckBoxControl",
    "text": "TextControl",
    "combobox": "ComboBoxControl",
    "menuitem": "MenuItemControl",
    "group": "GroupControl",
    "pane": "PaneControl",
}


def _match_window(args):
    """按标题子串或 pid 找窗口。

    ⚠️ 多窗口应用（如酷狗有 4 个顶层窗口）里"标题"可能为空，
       所以这里也支持 `pid`。**匹配到多个窗口时拒绝**，不猜。
    """
    _require_uia()
    want_title = args.get("window")
    want_pid = args.get("pid")
    if not isinstance(want_title, str) and not isinstance(want_pid, (int, float)):
        raise ValueError("需要 window（标题子串）或 pid 之一")

    matches = []
    for w in auto.GetRootControl().GetChildren():
        try:
            name = w.Name or ""
            pid = w.ProcessId
        except Exception:
            continue
        if isinstance(want_pid, (int, float)):
            if pid == int(want_pid):
                matches.append(w)
            continue
        if want_title and want_title in name:
            matches.append(w)

    if len(matches) == 0:
        raise LookupError(f"找不到窗口（window={want_title!r}, pid={want_pid}）")
    if len(matches) > 1:
        titles = [repr((m.Name or "")[:40]) for m in matches]
        raise LookupError(f"匹配到 {len(matches)} 个窗口，拒绝猜测：{titles}")
    return matches[0]


def _walk_controls(node, depth, out, max_depth, max_items):
    """遍历控件树。

    ⚠️ 返回 `truncated` 标记 —— 到上限就停时必须**告知**，
       否则调用方会以为"界面就这些控件"，从而得出错误结论。
       （第一版只按 max 截断而不报告，模型看到 200 个就以为全了。）
    """
    def walk(n, d):
        if d > max_depth or len(out) >= max_items:
            return
        for c in n.GetChildren():
            if len(out) >= max_items:
                return
            try:
                rect = c.BoundingRectangle
                out.append({
                    "depth": d,
                    "type": c.ControlTypeName,
                    "name": c.Name or "",
                    "automationId": c.AutomationId or "",
                    "className": c.ClassName or "",
                    "rect": [rect.left, rect.top, rect.right, rect.bottom],
                })
            except Exception:
                continue
            walk(c, d + 1)

    walk(node, depth)
    # 命中任一上限即视为可能被截断
    return len(out) >= max_items


def op_uia_tree(args):
    """导出某窗口的控件树（供"看清楚有什么"）。

    ★ 比截图更精确：截图要人（或模型）去认图，而这里直接给控件名与类型。
    """
    win = _match_window(args)
    max_depth = int(args.get("depth", 8))
    max_items = int(args.get("max", 200))
    out = []
    truncated = _walk_controls(win, 0, out, max_depth, max_items)
    return {
        "window": {"name": win.Name or "", "className": win.ClassName or "", "processId": win.ProcessId},
        "controls": out,
        "count": len(out),
        "truncated": truncated,
        "limits": {"depth": max_depth, "max": max_items},
    }


def _find_named(win, name, control_type=None, search_depth=14):
    """按名字（+可选类型）找控件，返回列表。

    ⚠️ 不自动取第一个 —— 由调用方（工具层）决定"唯一匹配才动手"。
    """
    want = name.strip()
    found = []
    stack = [(win, 0)]
    while stack:
        node, d = stack.pop()
        if d > search_depth:
            continue
        try:
            children = node.GetChildren()
        except Exception:
            continue
        for c in children:
            try:
                nm = (c.Name or "").strip()
                ct = c.ControlTypeName
            except Exception:
                continue
            if nm == want and (control_type is None or ct == control_type):
                found.append(c)
            stack.append((c, d + 1))
    return found


def _describe(c):
    try:
        r = c.BoundingRectangle
        return {
            "type": c.ControlTypeName,
            "name": c.Name or "",
            "automationId": c.AutomationId or "",
            "rect": [r.left, r.top, r.right, r.bottom],
        }
    except Exception:
        return {"type": "?", "name": "?", "automationId": "", "rect": [0, 0, 0, 0]}


def op_uia_find(args):
    """按名字找控件，报告有几个匹配、各自什么状态（**不操作**）。"""
    win = _match_window(args)
    name = args.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("需要 name（控件名，精确匹配）")
    ct = args.get("controlType")
    ct_name = CONTROL_TYPES.get(ct.lower()) if isinstance(ct, str) else None

    found = _find_named(win, name, ct_name)
    items = []
    for c in found[:10]:
        info = _describe(c)
        # 顺带报告它支持哪些模式 —— 决定能不能用**模式**操作（而不是坐标）
        pats = []
        for p, probe in (
            ("Invoke", lambda cc=c: cc.GetInvokePattern()),
            ("Toggle", lambda cc=c: cc.GetTogglePattern()),
            ("SelectionItem", lambda cc=c: cc.GetSelectionItemPattern()),
            ("ExpandCollapse", lambda cc=c: cc.GetExpandCollapsePattern()),
            ("Value", lambda cc=c: cc.GetValuePattern()),
        ):
            try:
                if probe() is not None:
                    pats.append(p)
            except Exception:
                # 控件声称支持但取不到（酷狗那种）—— 如实不列入
                pass
        info["patterns"] = pats
        items.append(info)

    return {"count": len(found), "matches": items}


def _supports(c, probe):
    """某控件是否**真的**支持某个模式。

    ⚠️ 注意：有的控件（酷狗那类自绘 UI）会"声称支持"但一用就抛 COMError。
       所以这里只做**能否取到 pattern 对象**的粗筛，
       真正调用的失败会在 action/set_value 里如实抛出。
    """
    try:
        return probe(c) is not None
    except Exception:
        return False


def _rect_of(c):
    try:
        r = c.BoundingRectangle
        return (r.left, r.top, r.right, r.bottom)
    except Exception:
        return None


def _rect_contains(outer, inner, tol=2):
    """外框是否包含内框（留 2px 容差，抗边框抖动）。"""
    if outer is None or inner is None:
        return False
    return (
        outer[0] - tol <= inner[0]
        and outer[1] - tol <= inner[1]
        and outer[2] + tol >= inner[2]
        and outer[3] + tol >= inner[3]
    )


def _outermost(cands):
    """把"同一个逻辑控件的多层"合并成一层。

    ★ 实测依据（Windows 设置搜索框）：
      同名 EditControl 有两个，**矩形完全相同** `(327,38,972,79)` ——
      那是父/子两层包着同一个输入框，不是两个输入框。

      而兄弟控件（不同区域的同名按钮）矩形**不重叠**，那才是真歧义。

    ⚠️ 所以规则是：
      ① 矩形完全相同 → 同一控件，去重
      ② 一个矩形包含另一个 → 取外层
      ③ 剩下多个**互不重叠**的 → 真歧义，返回多个让调用方拒绝

    （第一版用 UIA 父链判断嵌套，但 `GetParentControl()` 每次返回新实例、
      `==` 比较不可靠，导致父/子层被误判成"互不嵌套"。）
    """
    # ① 按矩形去重
    seen = {}
    for c in cands:
        rect = _rect_of(c)
        key = rect if rect is not None else id(c)
        if key not in seen:
            seen[key] = c
    uniq = list(seen.values())

    # ② 剔除被别的候选包含的（保留最外层）
    keep = []
    for c in uniq:
        rc = _rect_of(c)
        inside_other = any(
            _rect_contains(_rect_of(o), rc) and _rect_of(o) != rc
            for o in uniq if o is not c
        )
        if not inside_other:
            keep.append(c)
    return keep


def _pick_by_capability(found, probe, label):
    """在多个同名控件里挑出**真正具备该能力**的那个。

    ★ 为什么不是"取第一个"也不是"加 index 参数"：
      WinUI 里常见父 EditControl 套子 EditControl、同名 ListItem 套 TextControl ——
      它们是**同一个逻辑控件**的不同层，不是歧义。
      按能力筛选 + 剔除嵌套，能把这类"假歧义"消掉；
      **真正的歧义（兄弟控件）仍然拒绝**。
    """
    capable = [c for c in found if _supports(c, probe)]
    if len(capable) == 0:
        raise LookupError(
            f"找到 {len(found)} 个名为该名字的控件，但**没有一个**支持{label}"
            f"（这通常是自绘 UI：控件报了名字却不实现该模式）"
        )
    if len(capable) == 1:
        return capable[0]

    outer = _outermost(capable)
    if len(outer) == 1:
        return outer[0]
    raise LookupError(
        f"有 {len(outer)} 个**互不嵌套**的控件都支持{label}，拒绝猜测"
        f"（请用 controlType 缩小范围）"
    )


def op_uia_action(args):
    """按模式操作一个控件，并**读回状态做校验**。

    action: toggle | select | invoke | expand | collapse
    """
    win = _match_window(args)
    name = args.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("需要 name")
    action = args.get("action")
    if action not in ("toggle", "select", "invoke", "expand", "collapse"):
        raise ValueError("action 必须是 toggle/select/invoke/expand/collapse 之一")
    ct = args.get("controlType")
    ct_name = CONTROL_TYPES.get(ct.lower()) if isinstance(ct, str) else None

    found = _find_named(win, name, ct_name)
    if len(found) == 0:
        raise LookupError(f"找不到控件：{name!r}")

    # 每种 action 需要不同的模式 —— 按能力挑出能干活的那个
    PROBES = {
        "toggle": (lambda c: c.GetTogglePattern(), "TogglePattern"),
        "select": (lambda c: c.GetSelectionItemPattern(), "SelectionItemPattern"),
        "invoke": (lambda c: c.GetInvokePattern(), "InvokePattern"),
        "expand": (lambda c: c.GetExpandCollapsePattern(), "ExpandCollapsePattern"),
        "collapse": (lambda c: c.GetExpandCollapsePattern(), "ExpandCollapsePattern"),
    }
    probe, label = PROBES[action]
    c = _pick_by_capability(found, probe, label)

    # ⚠️ **操作前**就把控件信息快照下来。
    #    invoke 之后页面可能整体跳转，原元素会失效 ——
    #    第一版在操作后才 `_describe`，结果报了个 rect 全 0 的空控件。
    info = _describe(c)
    before = None
    after = None

    if action == "toggle":
        tp = c.GetTogglePattern()
        before = tp.ToggleState           # 0=Off 1=On 2=Indeterminate
        tp.Toggle()
    elif action == "select":
        sp = c.GetSelectionItemPattern()
        before = bool(sp.IsSelected)
        sp.Select()
    elif action == "invoke":
        c.GetInvokePattern().Invoke()
    elif action == "expand":
        c.GetExpandCollapsePattern().Expand()
    else:
        c.GetExpandCollapsePattern().Collapse()

    time.sleep(0.8)  # 让界面把状态写完

    # ★ 读回校验：重新找一次（toggle 后控件可能被重建）
    again = _find_named(win, name, ct_name) if action in ("toggle", "select") else []
    target = again[0] if again else c

    if action == "toggle":
        after = target.GetTogglePattern().ToggleState
        # toggle = "翻一下"：状态**必须翻转**才算生效
        verified = before != after
    elif action == "select":
        after = bool(target.GetSelectionItemPattern().IsSelected)
        # ★ select = "让它处于选中态"：**已经是选中态就是成功**（幂等）。
        #   第一版写成 `before != after`，于是"本来就选中"被误判为失败 ——
        #   这不是操作失败，是我把幂等操作当成了翻转操作。
        verified = after
    else:
        # invoke / expand / collapse 没有可读回的稳定状态，如实标 None
        verified = None

    return {
        "action": action,
        "control": info,
        "before": before,
        "after": after,
        "verified": verified,
    }


def op_uia_set_value(args):
    """给标准输入框设值（ValuePattern）。

    ⚠️ 自绘 UI（如酷狗 `kugou_ui`）会**声称支持但抛 COMError** ——
       这种情况如实报错，**不退回坐标点击**（那更不可靠）。
    """
    win = _match_window(args)
    name = args.get("name")
    value = args.get("value")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("需要 name")
    if not isinstance(value, str):
        raise ValueError("需要 value（字符串）")

    found = _find_named(win, name, CONTROL_TYPES.get("edit"))
    if len(found) == 0:
        found = _find_named(win, name)
    if len(found) == 0:
        raise LookupError(f"找不到输入控件：{name!r}")

    # 按能力挑（嵌套 EditControl 是"假歧义"，见 `_pick_by_capability`）
    c = _pick_by_capability(found, lambda x: x.GetValuePattern(), "ValuePattern")
    vp = c.GetValuePattern()
    before = vp.Value
    vp.SetValue(value)
    time.sleep(0.4)
    after = c.GetValuePattern().Value
    return {
        "control": _describe(c),
        "before": before,
        "after": after,
        "verified": after == value,
    }


OPS = {
    "ping": op_ping,
    "list_windows": op_list_windows,
    "office_convert": op_office_convert,
    "screenshot": op_screenshot,
    "uia_tree": op_uia_tree,
    "uia_find": op_uia_find,
    "uia_action": op_uia_action,
    "uia_set_value": op_uia_set_value,
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
