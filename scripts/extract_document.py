#!/usr/bin/env python
"""把常见文档/表格提取成纯文本，供对话使用。

用法：python scripts/extract_document.py <path>
输出：单行 JSON {ok, kind, text} 或 {ok:false, error}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

MAX_CHARS = 50_000


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(0)


def clip(text: str) -> str:
    text = text.replace("\x00", "").strip()
    if len(text) > MAX_CHARS:
        return text[:MAX_CHARS] + "\n…（内容过长，已截断）"
    return text


def extract(path: Path) -> tuple[str, str]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
        except Exception as exc:  # pragma: no cover - dependency probe
            fail(f"缺少 pypdf：{exc}")
        reader = PdfReader(str(path))
        pages = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                pages.append("")
        return "pdf", "\n\n".join(pages)

    if suffix == ".docx":
        try:
            import docx
        except Exception as exc:  # pragma: no cover
            fail(f"缺少 python-docx：{exc}")
        document = docx.Document(str(path))
        parts = [p.text for p in document.paragraphs if p.text.strip()]
        for table in document.tables:
            for row in table.rows:
                cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
                if any(cells):
                    parts.append(" | ".join(cells))
        return "docx", "\n".join(parts)

    if suffix in {".xlsx", ".xlsm"}:
        try:
            import openpyxl
        except Exception as exc:  # pragma: no cover
            fail(f"缺少 openpyxl：{exc}")
        workbook = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
        parts = []
        for sheet in workbook.worksheets:
            parts.append(f"## {sheet.title}")
            for row in sheet.iter_rows(min_row=1, max_row=200, max_col=20, values_only=True):
                cells = ["" if v is None else str(v) for v in row]
                if any(c.strip() for c in cells):
                    parts.append(" | ".join(cells).rstrip(" |"))
        return "xlsx", "\n".join(parts)

    if suffix in {".csv", ".txt", ".md", ".json"}:
        try:
            return suffix.lstrip("."), path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return suffix.lstrip("."), path.read_text(encoding="utf-8", errors="replace")

    fail(f"不支持的文档类型：{suffix or '(无扩展名)'}")


def main() -> None:
    if len(sys.argv) != 2:
        fail("用法：python extract_document.py <path>")
    path = Path(sys.argv[1])
    if not path.is_file():
        fail("文件不存在")
    kind, text = extract(path)
    print(json.dumps({"ok": True, "kind": kind, "text": clip(text)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
