"""桌宠的一轮对话：建会话 → 拉 SSE → 把事件翻成桌板能懂的话。

★★ 这里有一条**产品边界**，不是实现细节：
  桌板只显示「管家自己说给用户听的话」。
  模型的思考（reasoning）、工具名、工具参数、工具结果，一条都不往上报。
  理由很直接：桌板是一块 372 像素宽的浮窗，
  把工具细节塞进去只会让"正在执行"变成一串没人看得懂的英文。

★ 因此 `agent` 事件被整类丢弃；`progress` 只取阶段名；
  流式叙述（`narration`）才是真正的"阶段性汇报" —— 它由后端与执行并发跑，
  逐片到达，所以用户看到的是**真的在写**，而不是转圈之后的整段吐出。
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

from .api import ApiError, ButlerApi
from .store import session_settings_patch

# 阶段 key → 人话。桌板上只出现这一列词。
STAGE_LABEL = {
    'understand': '理解你的需求',
    'recall': '翻看记忆',
    'contract': '写下这次要做什么',
    'execute': '动手去做',
    'executed': '整理结果',
    'verify': '核对结果',
    'supervise': '复核一遍',
    'executeFailed': '换一种做法',
}

# 事件队列里的形状：(kind, payload)
Emit = Callable[[str, Any], None]


class ChatController:
    def __init__(
        self,
        api: ButlerApi,
        emit: Emit,
        *,
        session_id: str | None = None,
        on_session: Callable[[str], None] | None = None,
        config_provider: Callable[[], dict[str, Any]] | None = None,
        demo: bool = False,
    ) -> None:
        self.api = api
        self.emit = emit
        self.session_id = session_id
        self.on_session = on_session
        self.config_provider = config_provider or (lambda: {})
        self.demo = demo
        self._cancel = threading.Event()
        self._response: Any = None
        self._thread: threading.Thread | None = None
        self._running = False
        self._session_checked = False

    # ── 对外 ─────────────────────────────────────────

    @property
    def running(self) -> bool:
        return self._running

    def start(self, text: str, images: list[str] | None = None) -> bool:
        if self._running:
            return False
        self._running = True
        self._cancel.clear()
        worker = threading.Thread(
            target=self._demo_run if self.demo else self._run,
            args=(text, images or []),
            daemon=True,
        )
        self._thread = worker
        worker.start()
        return True

    def cancel(self) -> None:
        """立刻中断。

        ⚠️ 只设标志位不够：SSE 读操作阻塞在 socket 上，
           不关掉 response 的话它会等到下一片数据才发现要停。
           这里两件事一起做 —— 关连接 = 让后端的 abort 真的触发。
        """
        self._cancel.set()
        response = self._response
        if response is not None:
            try:
                response.close()
            except Exception:
                pass

    # ── 真流 ─────────────────────────────────────────

    def _ensure_session(self) -> str:
        if self.session_id:
            if self._session_checked:
                return self.session_id
            try:
                if self.api.session_exists(self.session_id):
                    self._session_checked = True
                    return self.session_id
            except ApiError:
                # 网络问题不能当成"会话不存在"，直接抛给上层报错
                raise
            self.session_id = None
        session_id = self.api.create_session()
        self.session_id = session_id
        self._session_checked = True
        if self.on_session is not None:
            self.on_session(session_id)
        # ★ 新建会话时把桌宠的模型/思考强度写进 session（新主应用）。
        #   旧主应用没有 PATCH 接口 → 404/405 时静默降级，后面仍用 body 旧字段。
        patch = session_settings_patch(self.config_provider())
        if patch:
            try:
                self.api.patch_session(session_id, patch)
            except ApiError:
                pass
        return session_id

    def _run(self, text: str, images: list[str]) -> None:
        started = time.monotonic()
        cancelled = False
        try:
            self.emit('started', {'at': started})
            session_id = self._ensure_session()
            config = self.config_provider()
            body: dict[str, Any] = {
                'sessionId': session_id,
                'text': text,
                # 桌宠处理不了确认卡：明确声明不支持，让后端立刻拒绝，
                # 而不是让需要确认的工具挂满 120 秒超时。
                'supportsApproval': False,
            }
            model = config.get('model')
            if isinstance(model, dict):
                if isinstance(model.get('profileId'), str):
                    body['modelProfileId'] = model['profileId']
                if isinstance(model.get('modelId'), str):
                    body['modelId'] = model['modelId']
            persona = config.get('persona')
            if isinstance(persona, str) and persona.strip():
                body['persona'] = persona.strip()
            # 旧桌宠的思考档位（default/low/medium/high）：
            # 后端做兼容映射，不要求桌宠改 UI；新 Web 用会话级 reasoning。
            thinking = config.get('thinkingLevel')
            if isinstance(thinking, str) and thinking in ('default', 'low', 'medium', 'high'):
                body['thinkingLevel'] = thinking
            if images:
                body['images'] = [{'url': url} for url in images]

            response = self.api.open_chat_stream(body)
            self._response = response
            for event in self.api.iter_events(response, self._cancel):
                kind = event.get('type')
                if kind == 'progress':
                    self._on_progress(event)
                elif kind == 'narration':
                    self.emit(
                        'narration',
                        {
                            'text': event.get('answer') if isinstance(event.get('answer'), str) else '',
                            'done': bool(event.get('done')),
                        },
                    )
                elif kind == 'reply':
                    reply = event.get('text')
                    if isinstance(reply, str):
                        self.emit('reply', reply)
                elif kind == 'reflection':
                    reflection = event.get('reflection')
                    if isinstance(reflection, dict):
                        self.emit(
                            'reflection',
                            {
                                'pending': reflection.get('pendingReview') or 0,
                                'admitted': reflection.get('admittedAutonomously') or 0,
                            },
                        )
                elif kind == 'error':
                    message = event.get('message')
                    self.emit('error', message if isinstance(message, str) else '这一轮出错了')
                elif kind == 'done':
                    break
                # session / user / agent / contract / usage / verdict / reports / audit
                # 一律不处理：桌板不显示思考与工具细节。
        except ApiError as err:
            if self._cancel.is_set():
                cancelled = True
            else:
                self.emit('error', str(err))
        except Exception as err:  # noqa: BLE001 —— 流中断不能让 Tk 线程崩
            if self._cancel.is_set():
                cancelled = True
            else:
                self.emit('error', f'连接中断：{err}')
        finally:
            self._response = None
            self._running = False
            if cancelled or self._cancel.is_set():
                self.emit('cancelled', None)
            self.emit('finished', {'elapsed': time.monotonic() - started})

    def _on_progress(self, event: dict[str, Any]) -> None:
        """只取阶段名。

        ⚠️ 后端的 `execute` 阶段 label 是「开始执行：<交付物前 24 字>」——
           桌板顶部只放得下一行状态，取冒号前的阶段名，剩下的留给正文。
        """
        inner = event.get('event')
        if not isinstance(inner, dict) or inner.get('kind') != 'stage':
            return
        stage = inner.get('stage')
        label = STAGE_LABEL.get(stage) if isinstance(stage, str) else None
        if label is None:
            raw = inner.get('label')
            label = raw.strip() if isinstance(raw, str) else ''
            if '：' in label:
                label = label.split('：', 1)[0]
            label = label[:10]
        if label:
            self.emit('stage', label)

    # ── 演示流（没有主应用时也能看界面）─────────────

    def _demo_run(self, text: str, _images: list[str]) -> None:
        cancelled = False
        started = time.monotonic()
        try:
            self.emit('started', {'at': started})
            steps = [
                (0.35, 'stage', '理解你的需求'),
                (0.75, 'stage', '翻看记忆'),
                (0.55, 'stage', '写下这次要做什么'),
            ]
            for delay, kind, payload in steps:
                if self._sleep(delay):
                    cancelled = True
                    return
                self.emit(kind, payload)

            narration = (
                '我先把今天这几件事排一下顺序：有明确时限的先处理，'
                '采买清单放中间，晚上的课程看通知再定。'
                '我还会顺手核一下冰箱里已有的东西，免得重复买。'
            )
            for index in range(1, len(narration) + 1, 4):
                if self._sleep(0.055):
                    cancelled = True
                    return
                self.emit('narration', {'text': narration[:index], 'done': False})
            self.emit('narration', {'text': narration, 'done': True})

            for delay, label in ((0.5, '动手去做'), (0.7, '核对结果')):
                if self._sleep(delay):
                    cancelled = True
                    return
                self.emit('stage', label)

            if self._sleep(0.35):
                cancelled = True
                return
            self.emit('reply', DEMO_REPLY)
            self.emit('reflection', {'pending': 2, 'admitted': 1})
        finally:
            self._running = False
            if cancelled or self._cancel.is_set():
                self.emit('cancelled', None)
            self.emit('finished', {'elapsed': time.monotonic() - started})

    def _sleep(self, seconds: float) -> bool:
        return self._cancel.wait(seconds)


DEMO_USER_TEXT = '帮我理一下今天要做的事，顺便看看冰箱里还缺什么。'

DEMO_REPLY = (
    '我把今天的事理成一条线：\n\n'
    '一、上午 10:00 前把评审意见回给林工 —— 要点我先列在下面，你点头我就发。\n'
    '二、下午的采购清单里，牛奶和电池是上周漏掉的；冰箱里还有两盒酸奶，这次不买。\n'
    '三、晚上 19:30 的课程如果取消，提醒顺延到周三，你不用另行记。\n\n'
    '要我现在把第一条的回复草稿写出来吗？'
)
