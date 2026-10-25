#!/usr/bin/env python
"""Generate real PDF/DOCX/XLSX fixtures for the upload E2E.

Usage: python scripts/make-doc-fixtures.py <output-dir>
"""
from __future__ import annotations

import sys
from pathlib import Path


def make_docx(path: Path) -> None:
    from docx import Document

    doc = Document()
    doc.add_heading("付款条款", level=1)
    doc.add_paragraph("甲方应在验收后三十天内付款。")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "阶段"
    table.cell(0, 1).text = "比例"
    table.cell(1, 0).text = "验收"
    table.cell(1, 1).text = "100%"
    doc.save(str(path))


def make_xlsx(path: Path) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "销售"
    ws.append(["产品", "销量"])
    ws.append(["A", 120])
    ws.append(["B", 80])
    wb.save(str(path))


def make_pdf(path: Path) -> None:
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    font = Path(r"C:\Windows\Fonts\msyh.ttc")
    if font.exists():
        pdf.add_font("msyh", "", str(font))
        pdf.set_font("msyh", size=12)
        text = "体检报告\n低密度脂蛋白 LDL 为 3.8 mmol/L，建议三个月后复查。"
    else:
        pdf.set_font("helvetica", size=12)
        text = "Health report\nLDL is 3.8 mmol/L; recheck in three months."
    pdf.multi_cell(0, 8, text)
    pdf.output(str(path))


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    out.mkdir(parents=True, exist_ok=True)
    make_docx(out / "sample.docx")
    make_xlsx(out / "sample.xlsx")
    make_pdf(out / "sample.pdf")
    print(str(out))


if __name__ == "__main__":
    main()
