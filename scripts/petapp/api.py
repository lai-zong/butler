"""桌宠 → 主应用的最小 HTTP 客户端。

★ 只包四件事，多一件都不加：
  ① JSON 请求（GET/POST/PUT）
  ② 一条 SSE 流（`/api/chat`）
  ③ 一个 multipart 上传（文档提取）
  ④ 几个读接口的形状收窄（会话 / 模型 / 提醒 / 配置）

⚠️ 这里**不做重试**。桌宠是"人在旁边看着"的窗口，
   失败要立刻说清楚"主应用没连上"，而不是在后台悄悄重试三分钟。
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable

DEFAULT_BASE_URL = 'http://127.0.0.1:3000'


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def _base_url() -> str:
    return (os.environ.get('BUTLER_URL') or DEFAULT_BASE_URL).rstrip('/')


class ButlerApi:
    def __init__(self, base_url: str | None = None, timeout: float = 20.0) -> None:
        self.base_url = (base_url or _base_url()).rstrip('/')
        self.timeout = timeout

    # ── 基础请求 ─────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
        raw_body: bytes | None = None,
        content_type: str | None = None,
    ) -> Any:
        data = raw_body
        headers: dict[str, str] = {}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if content_type is not None:
            headers['Content-Type'] = content_type
        req = urllib.request.Request(
            f'{self.base_url}{path}', data=data, method=method, headers=headers
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                payload = resp.read().decode('utf-8', 'replace')
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as err:
            detail = err.read().decode('utf-8', 'replace')
            message = detail
            try:
                parsed = json.loads(detail)
                if isinstance(parsed, dict) and isinstance(parsed.get('error'), str):
                    message = parsed['error']
            except Exception:
                pass
            raise ApiError(f'HTTP {err.code}: {message or err.reason}', status=err.code) from err
        except urllib.error.URLError as err:
            raise ApiError(f'连不上主应用（{self.base_url}）：{err.reason}') from err
        except Exception as err:
            raise ApiError(str(err)) from err

    def get(self, path: str, timeout: float | None = None) -> Any:
        return self.request('GET', path, None, timeout=timeout)

    def post(self, path: str, body: dict[str, Any] | None = None, timeout: float | None = None) -> Any:
        return self.request('POST', path, body if body is not None else {}, timeout=timeout)

    def put(self, path: str, body: dict[str, Any]) -> Any:
        return self.request('PUT', path, body)

    def patch(self, path: str, body: dict[str, Any]) -> Any:
        return self.request('PATCH', path, body)

    # ── 读接口（形状收窄在调用方做，这里只保证返回 dict / list）──

    def health(self) -> bool:
        try:
            data = self.get('/api/status', timeout=3)
            return isinstance(data, dict) and data.get('ok') is True
        except Exception:
            return False

    def create_session(self) -> str:
        data = self.post('/api/sessions')
        session = data.get('session') if isinstance(data, dict) else None
        session_id = session.get('id') if isinstance(session, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise ApiError('主应用没有返回会话 id')
        return session_id

    def session_exists(self, session_id: str) -> bool:
        try:
            self.get(f'/api/sessions/{urllib.parse.quote(session_id)}')
            return True
        except ApiError as err:
            if err.status == 404:
                return False
            raise

    def patch_session(self, session_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        """把桌宠设置同步到对应会话（模型 / 思考强度）。

        ⚠️ 旧主应用没有 PATCH 会话接口：调用方应对 404/405 静默降级，
           继续依赖 `/api/chat` body 的旧字段兜底。
        """
        data = self.patch(f'/api/sessions/{urllib.parse.quote(session_id)}', patch)
        session = data.get('session') if isinstance(data, dict) else None
        return session if isinstance(session, dict) else {}

    def last_assistant_text(self, session_id: str) -> str:
        """取这个会话最后一条管家回复 —— 用来在桌板上显示"上次说到哪"。"""
        data = self.get(f'/api/sessions/{urllib.parse.quote(session_id)}')
        messages = data.get('messages') if isinstance(data, dict) else None
        if not isinstance(messages, list):
            return ''
        for message in reversed(messages):
            if not isinstance(message, dict):
                continue
            role = message.get('role')
            text = message.get('text')
            if role in ('assistant', 'butler') and isinstance(text, str) and text.strip():
                return text.strip()
        return ''

    def chat_models(self) -> list[dict[str, Any]]:
        """可选的聊天模型。返回 [{profileId, profileName, modelId, label}]。"""
        try:
            data = self.get('/api/model', timeout=8)
        except ApiError:
            return []
        out: list[dict[str, Any]] = []
        profiles = data.get('profiles') if isinstance(data, dict) else None
        if not isinstance(profiles, list):
            return out
        for profile in profiles:
            if not isinstance(profile, dict):
                continue
            pid = profile.get('id')
            pname = profile.get('name') if isinstance(profile.get('name'), str) else pid
            models = profile.get('models')
            if not isinstance(pid, str) or not isinstance(models, list):
                continue
            for model in models:
                if not isinstance(model, dict):
                    continue
                if model.get('kind') != 'chat':
                    continue
                mid = model.get('id')
                if isinstance(mid, str):
                    out.append(
                        {
                            'profileId': pid,
                            'profileName': pname,
                            'modelId': mid,
                            'label': f'{pname} · {mid}',
                        }
                    )
        return out

    def active_turns(self) -> list[dict[str, Any]]:
        """主界面里正在执行的轮次。老服务端没有这个接口时安静返回空。"""
        try:
            data = self.get('/api/pet/active', timeout=4)
        except ApiError:
            return []
        active = data.get('active') if isinstance(data, dict) else None
        if not isinstance(active, list):
            return []
        out: list[dict[str, Any]] = []
        for item in active:
            if not isinstance(item, dict):
                continue
            session = item.get('sessionId')
            if isinstance(session, str) and session:
                out.append(item)
        return out

    def focus_session(self, session_id: str) -> bool:
        """请已经打开的 Web 页面自己跳到这条会话。

        ⚠️ 这里只登记请求，**不打开浏览器**：页面用 GET 轮询取走。
           旧主应用没有这个端点（404）或网络不通时返回 False；
           调用方仍会把已有窗口提到前台，不因为这一步失败而新开窗口。
           超时压到 2s —— 点击是交互动作，不能让人等。
        """
        if not isinstance(session_id, str) or not session_id.strip():
            return False
        try:
            self.post('/api/pet/focus', {'sessionId': session_id}, timeout=2.0)
            return True
        except ApiError:
            return False

    def due_reminders(self) -> list[dict[str, Any]]:
        try:
            data = self.get('/api/tasks', timeout=10)
        except ApiError:
            return []
        tasks = data.get('tasks') if isinstance(data, dict) else None
        if not isinstance(tasks, list):
            return []
        return [
            t
            for t in tasks
            if isinstance(t, dict)
            and t.get('kind') == 'reminder'
            and t.get('status') == 'active'
            and t.get('due') is True
        ]

    def get_config(self) -> dict[str, Any]:
        data = self.get('/api/pet/config')
        config = data.get('config') if isinstance(data, dict) else None
        return config if isinstance(config, dict) else {}

    def put_config(self, patch: dict[str, Any]) -> dict[str, Any]:
        data = self.put('/api/pet/config', patch)
        config = data.get('config') if isinstance(data, dict) else None
        return config if isinstance(config, dict) else {}

    # ── 文档提取 ─────────────────────────────────────

    def extract_document(self, path: Path) -> dict[str, Any]:
        """把本地文档交给主应用的解析端点，拿回纯文本。

        ⚠️ 文件名用 ASCII 占位（`upload<ext>`）：
           中文文件名直接写进 multipart 头会被 Node 按 latin1 解成乱码，
           而端点只按扩展名选解析器，名字是什么并不影响结果。
        """
        ext = path.suffix.lower()
        data = path.read_bytes()
        boundary = '----butler' + uuid.uuid4().hex
        head = (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="file"; filename="upload{ext}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n'
        ).encode('utf-8')
        tail = f'\r\n--{boundary}--\r\n'.encode('utf-8')
        payload = head + data + tail
        result = self.request(
            'POST',
            '/api/attachments/extract',
            raw_body=payload,
            content_type=f'multipart/form-data; boundary={boundary}',
            timeout=45,
        )
        return result if isinstance(result, dict) else {}

    # ── SSE ─────────────────────────────────────────

    def open_chat_stream(self, body: dict[str, Any]) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(
            f'{self.base_url}/api/chat',
            data=data,
            method='POST',
            headers={'Content-Type': 'application/json', 'Accept': 'text/event-stream'},
        )
        try:
            return urllib.request.urlopen(req, timeout=300)
        except urllib.error.HTTPError as err:
            detail = err.read().decode('utf-8', 'replace')
            try:
                parsed = json.loads(detail)
                if isinstance(parsed, dict) and isinstance(parsed.get('error'), str):
                    detail = parsed['error']
            except Exception:
                pass
            raise ApiError(f'HTTP {err.code}: {detail}', status=err.code) from err
        except urllib.error.URLError as err:
            raise ApiError(f'连不上主应用（{self.base_url}）：{err.reason}') from err

    @staticmethod
    def iter_events(response: Any, cancel: threading.Event | None = None) -> Iterable[dict[str, Any]]:
        try:
            for raw in response:
                if cancel is not None and cancel.is_set():
                    return
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:'):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    yield event
        finally:
            try:
                response.close()
            except Exception:
                pass


def run_in_thread(target: Callable[[], None]) -> threading.Thread:
    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread
