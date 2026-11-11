/**
 * Office 只读预览（零依赖 zip + XML）
 *
 * 用真正构造出来的最小 docx / xlsx 验证：
 * 段落抽取、共享字符串、单元格值、损坏文件与不支持扩展名的报错。
 */

import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { docxToText, OfficePreviewError, previewOffice, xlsxToTable } from '../officePreview.js';

// ── 造一个最小 zip（deflate） ──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries: readonly { name: string; text: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.text, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDir, eocd]);
}

const DOCX_XML = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>第一段：面板预览</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段 &amp; 特殊字符</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const XLSX_SHARED = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>姓名</t></si><si><t>分数</t></si><si><t>张三</t></si>
</sst>`;

const XLSX_SHEET = `<?xml version="1.0"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
  <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>97</v></c></row>
</sheetData></worksheet>`;

const XLSX_WORKBOOK = `<?xml version="1.0"?>
<workbook><sheets><sheet name="成绩" sheetId="1"/></sheets></workbook>`;

describe('docx 预览', () => {
  it('抽出段落文本', () => {
    const zip = makeZip([{ name: 'word/document.xml', text: DOCX_XML }, { name: '[Content_Types].xml', text: '<x/>' }]);
    const preview = previewOffice(zip, '.docx');
    expect(preview.kind).toBe('text');
    if (preview.kind !== 'text') return;
    expect(preview.text).toContain('第一段：面板预览');
    expect(preview.text).toContain('第二段 & 特殊字符');
    expect(preview.note).toContain('只读预览');
  });

  it('段落转换函数本身', () => {
    expect(docxToText(DOCX_XML)).toBe('第一段：面板预览\n第二段 & 特殊字符');
  });
});

describe('xlsx 预览', () => {
  it('共享字符串 + 数字单元格', () => {
    const zip = makeZip([
      { name: 'xl/workbook.xml', text: XLSX_WORKBOOK },
      { name: 'xl/sharedStrings.xml', text: XLSX_SHARED },
      { name: 'xl/worksheets/sheet1.xml', text: XLSX_SHEET },
    ]);
    const preview = previewOffice(zip, '.xlsx');
    expect(preview.kind).toBe('table');
    if (preview.kind !== 'table') return;
    expect(preview.sheet).toBe('成绩');
    expect(preview.rows[0]).toEqual(['姓名', '分数']);
    expect(preview.rows[1]).toEqual(['张三', '97']);
  });

  it('转换函数对空表也稳定', () => {
    const preview = xlsxToTable({ sharedStrings: '', sheet: '<worksheet><sheetData/></worksheet>', sheetName: 'S' });
    expect(preview.kind).toBe('table');
    if (preview.kind !== 'table') return;
    expect(preview.rows).toEqual([]);
  });
});

describe('错误边界', () => {
  it('不支持旧版 .doc', () => {
    expect(() => previewOffice(Buffer.from('x'), '.doc')).toThrow(OfficePreviewError);
  });

  it('坏 zip 报 corrupt', () => {
    try {
      previewOffice(Buffer.from('not a zip at all'), '.docx');
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(OfficePreviewError);
      expect((err as OfficePreviewError).code).toBe('corrupt');
    }
  });

  it('缺 body 的 docx 报错', () => {
    const zip = makeZip([{ name: '[Content_Types].xml', text: '<x/>' }]);
    expect(() => previewOffice(zip, '.docx')).toThrow(OfficePreviewError);
  });
});
