"""语音输入 —— 用 Windows 自带的 SAPI 听写，不联网、不额外装依赖。

★ 为什么是 SAPI 而不是"录下来发给模型"：
  桌宠是主界面之外的快捷入口，录音上传一来要新增端点，二来要等模型转写，
  延迟比打字还高。Windows 自带的中文听写在本机就能出字，够用。

★ 三条纪律：
  ① 缺语音组件时**如实报错**，不要让按钮看起来能用；
  ② 识别结果只往输入框里**追加**，不自动发送 —— 听错一个字就替用户发出去，
     比没有语音更糟；
  ③ 听写有 30 秒上限，用户忘了关也不会一直占着麦克风。
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

MAX_LISTEN_SECONDS = 20.0

# 识别事件位（SpeechRecoEvents）
SRE_STREAM_END = 1
SRE_RECOGNITION = 1024
SRE_HYPOTHESIS = 2048


class _Handler:
    """SAPI 事件回调。

    ⚠️ 两条都是踩出来的：
       ① `DispatchWithEvents` 的第二个参数必须是**类**，不是实例 ——
          传实例会得到一个 "metaclass conflict" 的费解错误；
       ② 事件处理器**必须把 in/out 参数原样返回**，
          否则 COM 侧会报类型错误。
    """

    emit = staticmethod(lambda kind, payload=None: None)  # 由子类替换

    def OnRecognition(self, StreamNumber, StreamPosition, RecognitionType, Result):  # noqa: N802
        text = ''
        try:
            recognized = Result.RecognizedText
            text = recognized if isinstance(recognized, str) else ''
        except Exception:
            try:
                text = Result.PhraseInfo.GetText() or ''
            except Exception:
                text = ''
        if text.strip():
            try:
                self.emit('text', text.strip())
            except Exception:
                pass
        return (StreamNumber, StreamPosition, Result)

    def OnHypothesis(self, StreamNumber, StreamPosition, Result):  # noqa: N802
        return (StreamNumber, StreamPosition, Result)

    def OnStreamEnd(self, StreamNumber, StreamPosition):  # noqa: N802
        return (StreamNumber, StreamPosition)


class Dictation:
    def __init__(self, emit: Callable[[str, Any], None]) -> None:
        self.emit = emit
        self.last_error = ''
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._got_text = False

    def available(self) -> bool:
        try:
            import pythoncom  # noqa: F401
            import win32com.client  # noqa: F401
        except Exception as err:
            self.last_error = f'这台电脑没有语音组件（{err}）'
            return False
        return True

    def start(self) -> bool:
        if self._thread is not None and self._thread.is_alive():
            return True
        if not self.available():
            return False
        self._stop.clear()
        self._got_text = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()

    def _on_text(self, text: str) -> None:
        self._got_text = True
        self.emit('text', text)

    def _run(self) -> None:
        pythoncom = None
        ok = False
        try:
            import pythoncom  # type: ignore
            import win32com.client  # type: ignore

            pythoncom.CoInitialize()
            recognizer = win32com.client.Dispatch('SAPI.SpSharedRecognizer')
            context = recognizer.CreateRecoContext()
            try:
                context.EventInterests = SRE_STREAM_END | SRE_RECOGNITION | SRE_HYPOTHESIS
            except Exception:
                pass
            handler_class = type(
                'ButlerSapiHandler',
                (_Handler,),
                {'emit': staticmethod(self._on_text)},
            )
            events = win32com.client.DispatchWithEvents(context, handler_class)
            grammar = context.CreateGrammar()
            try:
                grammar.DictationSetState(1)
            except Exception as err:
                raise RuntimeError(f'打不开听写：{err}') from err
            try:
                context.State = 1
            except Exception:
                pass
            self.emit('started', None)
            deadline = time.monotonic() + MAX_LISTEN_SECONDS
            while not self._stop.is_set() and time.monotonic() < deadline:
                pythoncom.PumpWaitingMessages()
                time.sleep(0.03)
            try:
                grammar.DictationSetState(0)
            except Exception:
                pass
            try:
                context.State = 0
            except Exception:
                pass
            ok = True
            del events
        except Exception as err:  # noqa: BLE001
            self.last_error = str(err) or '语音识别启动失败'
            self.emit('error', self.last_error)
        finally:
            if pythoncom is not None:
                try:
                    pythoncom.CoUninitialize()
                except Exception:
                    pass
            if ok:
                self.emit('done', {'got': self._got_text})
