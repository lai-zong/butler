"""输入框里的附件：图片转 data URL，文档交给主应用提取文本。

★ 边界（与 Web 版一致的取舍）：
  · 图片走 `/api/chat` 的 `images` 字段（data URL），这一轮有效、不落历史；
  · 文档走 `/api/attachments/extract` 提取成纯文本，随消息正文一起发；
  · 一次最多 10 个附件（与 `core/multimodal/attach.ts` 的上限对齐）。

⚠️ 图片必须先缩放：手机截图动辄 6—8MB，base64 之后十几 MB，
   一次 POST 过去主应用可能直接 413。这里按最长边 1600px 重编码，
   肉眼无损、请求体小一个数量级。
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from .draw import human_size

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
DOC_EXTS = {'.pdf', '.docx', '.xlsx', '.xlsm', '.csv', '.txt', '.md', '.json'}

MAX_ATTACHMENTS = 10
MAX_DOC_CHARS = 6000  # 单个文档塞进正文的上限
MAX_TOTAL_DOC_CHARS = 12000
MAX_IMAGE_EDGE = 1600
MAX_DATA_URL_BYTES = 8 * 1024 * 1024

IMAGE_KIND = 'image'
DOC_KIND = 'document'


@dataclass
class Attachment:
    path: Path
    name: str
    kind: str  # image | document
    size: int = 0
    status: str = 'loading'  # loading | ready | error
    detail: str = ''
    text: str = ''
    data_url: str = ''
    error: str = ''

    @property
    def ready(self) -> bool:
        return self.status == 'ready'

    @property
    def failed(self) -> bool:
        return self.status == 'error'


def classify(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTS:
        return IMAGE_KIND
    if ext in DOC_EXTS:
        return DOC_KIND
    return None


def make_attachment(path: Path) -> Attachment | None:
    try:
        size = path.stat().st_size
    except OSError:
        return None
    kind = classify(path)
    if kind is None:
        return None
    return Attachment(path=path, name=path.name, kind=kind, size=size)


def load_image(att: Attachment) -> None:
    """读图 → 缩放 → data URL。GIF 只取第一帧（模型看动图没有意义）。"""
    try:
        with Image.open(att.path) as img:
            img.load()
            if img.mode not in ('RGB', 'RGBA'):
                img = img.convert('RGBA')
            if max(img.width, img.height) > MAX_IMAGE_EDGE:
                img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
            has_alpha = img.mode == 'RGBA' and img.getchannel('A').getextrema()[0] < 250
            buffer = io.BytesIO()
            if has_alpha:
                img.save(buffer, format='PNG', optimize=True)
                mime = 'image/png'
            else:
                img.convert('RGB').save(buffer, format='JPEG', quality=88, optimize=True)
                mime = 'image/jpeg'
            raw = buffer.getvalue()
            if len(raw) > MAX_DATA_URL_BYTES:
                # 还是太大：降质量再试一次，仍然超限就如实报错
                buffer = io.BytesIO()
                img.convert('RGB').save(buffer, format='JPEG', quality=68, optimize=True)
                raw = buffer.getvalue()
                mime = 'image/jpeg'
            if len(raw) > MAX_DATA_URL_BYTES:
                raise ValueError('图片压缩后仍超过 8 MB')
            att.data_url = f'data:{mime};base64,' + base64.b64encode(raw).decode('ascii')
            att.detail = f'{img.width}×{img.height} · {human_size(len(raw))}'
            att.status = 'ready'
    except Exception as err:  # noqa: BLE001 —— 单张图失败不能拖垮整个输入框
        att.status = 'error'
        att.error = str(err) or '图片读取失败'
        att.detail = '读取失败'


def load_document(att: Attachment, api) -> None:
    """调主应用解析文档。解析失败要保留原因，而不是静默变成空文本。"""
    try:
        result = api.extract_document(att.path)
        if result.get('ok') is not True or not isinstance(result.get('text'), str):
            raise ValueError(result.get('error') if isinstance(result.get('error'), str) else '解析失败')
        text = result['text'].strip()
        if not text:
            raise ValueError('没有解析出文字')
        att.text = text
        count = len(text)
        att.detail = f'已提取 {count} 字' if count <= MAX_DOC_CHARS else f'已提取 {count} 字（发送时截断）'
        att.status = 'ready'
    except Exception as err:  # noqa: BLE001
        att.status = 'error'
        att.error = str(err)
        att.detail = '读取失败'


def compose_message(text: str, attachments: list[Attachment]) -> str:
    """把附件正文拼进消息。

    ★ 为什么要带文件名：模型需要知道"这段话来自哪个文件"，
      否则多附件时它会把这几个片段混成一段。
    """
    parts = [text.strip()]
    budget = MAX_TOTAL_DOC_CHARS
    for att in attachments:
        if att.kind != DOC_KIND or not att.ready or budget <= 0:
            continue
        body = att.text[: min(MAX_DOC_CHARS, budget)]
        budget -= len(body)
        cut = '（已截断）' if len(att.text) > len(body) else ''
        parts.append(f'【附件 · {att.name}{cut}】\n{body}')
    return '\n\n'.join(part for part in parts if part)
