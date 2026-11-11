/**
 * Office 文档的只读预览（零依赖）
 *
 * ★ 为什么不用 mammoth / SheetJS：
 *   面板只是"看一眼"，两个库加起来体积不小，而 docx/xlsx 本质是 **zip + XML**，
 *   自己解出段落与单元格就够用；需要完整排版时给一句"用系统应用打开"。
 *
 * ★ 为什么不用 `desktop_office_convert`：
 *   它走 Windows COM（要求本机装了 Word），是给桌面自动化用的；
 *   面板预览不该依赖 Office 是否安装。
 *
 * ⚠️ 边界：
 *   · 只支持 .docx / .xlsx（旧版 .doc/.xls 是二进制，不支持，会提示）；
 *   · 不出样式、不出图片、不出公式计算过程（只取缓存值）；
 *   · 输出有上限，避免一个巨型表格把界面卡死。
 */

import { inflateRawSync } from 'node:zlib';

export class OfficePreviewError extends Error {
  override readonly name = 'OfficePreviewError';
  constructor(
    message: string,
    readonly code: 'unsupported' | 'corrupt' | 'too_large',
  ) {
    super(message);
  }
}

/** 预览结果：PDF 由浏览器内置查看器渲染，docx/xlsx 转成文本或表格。 */
export type OfficePreview =
  | { readonly kind: 'text'; readonly text: string; readonly note: string }
  | {
      readonly kind: 'table';
      readonly sheet: string;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
      readonly note: string;
    };

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 300_000;
const MAX_ROWS = 2000;
const MAX_COLS = 50;

// ═══════════════════════════════════════════════════════════
// 最小 ZIP 读取（只读中央目录 + deflate/store）
// ═══════════════════════════════════════════════════════════

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

function readZip(buffer: Buffer): Map<string, ZipEntry> {
  // 找 End Of Central Directory（EOCD 签名 0x06054b50，从尾部往前扫）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new OfficePreviewError('文件不是有效的 Office 文档（找不到 zip 目录）', 'corrupt');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new OfficePreviewError('Office 文档目录损坏', 'corrupt');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

    // 本地文件头：30 字节 + 文件名 + extra，之后才是数据
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new OfficePreviewError('Office 文档使用了不支持的压缩方式', 'corrupt');

    entries.set(name, { name, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════
// XML 文本抽取（够用即可，不做完整解析器）
// ═══════════════════════════════════════════════════════════

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** docx：段落按行、表格行按 ` | ` 拼接。 */
export function docxToText(xml: string): string {
  const lines: string[] = [];
  // 每个 <w:p> 是一段；段内的 <w:t> 拼起来
  const paragraphs = xml.split(/<w:p[ >]/).slice(1);
  for (const paragraph of paragraphs) {
    const texts = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1] ?? ''));
    const line = texts.join('').replace(/\s+$/g, '');
    lines.push(line);
    if (lines.length >= MAX_ROWS) break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** xlsx：取共享字符串 + 第一张表，输出行列文本。 */
export function xlsxToTable(args: {
  readonly sharedStrings: string;
  readonly sheet: string;
  readonly sheetName: string;
}): OfficePreview {
  const shared: string[] = [];
  for (const m of args.sharedStrings.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...(m[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1] ?? ''));
    shared.push(texts.join(''));
  }

  const rows: string[][] = [];
  let truncated = false;
  for (const rowMatch of args.sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (cells.length >= MAX_COLS) {
        truncated = true;
        break;
      }
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const isShared = /\bt="s"/.test(attrs);
      const isInline = /\bt="inlineStr"/.test(attrs);
      const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
      const inlineMatch = /<is>([\s\S]*?)<\/is>/.exec(body);
      let value = '';
      if (isShared) {
        const index = valueMatch === null ? NaN : Number(valueMatch[1]);
        value = Number.isInteger(index) ? (shared[index] ?? '') : '';
      } else if (isInline) {
        value = decodeXml(
          [...(inlineMatch?.[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? '').join(''),
        );
      } else if (valueMatch !== null) {
        value = decodeXml(valueMatch[1] ?? '');
      }
      cells.push(value);
    }
    rows.push(cells);
  }

  return {
    kind: 'table',
    sheet: args.sheetName,
    rows,
    truncated,
    note: '只读预览：只显示单元格的值，不显示样式、公式与图片。完整排版请用系统应用打开。',
  };
}

// ═══════════════════════════════════════════════════════════
// 对外入口
// ═══════════════════════════════════════════════════════════

export function previewOffice(buffer: Buffer, extension: string): OfficePreview {
  if (buffer.byteLength > MAX_INPUT_BYTES) {
    throw new OfficePreviewError('文件超过 20 MB，面板不预览', 'too_large');
  }
  const ext = extension.toLowerCase();
  if (ext !== '.docx' && ext !== '.xlsx') {
    throw new OfficePreviewError('只支持 .docx / .xlsx 的只读预览（.doc/.xls 请用系统应用打开）', 'unsupported');
  }

  let zip: Map<string, ZipEntry>;
  try {
    zip = readZip(buffer);
  } catch (err) {
    if (err instanceof OfficePreviewError) throw err;
    throw new OfficePreviewError('Office 文档解析失败', 'corrupt');
  }

  if (ext === '.docx') {
    const doc = zip.get('word/document.xml');
    if (doc === undefined) throw new OfficePreviewError('这个 docx 里没有正文（word/document.xml）', 'corrupt');
    const text = docxToText(doc.data.toString('utf8')).slice(0, MAX_TEXT_CHARS);
    return {
      kind: 'text',
      text,
      note: '只读预览：只显示文字与段落，不显示样式、图片与批注。完整排版请用系统应用打开。',
    };
  }

  const workbook = zip.get('xl/workbook.xml');
  const sheetFile = [...zip.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (sheetFile === undefined) throw new OfficePreviewError('这个 xlsx 里没有工作表', 'corrupt');

  const sheetNameMatch = workbook === undefined ? null : /<sheet[^>]*name="([^"]+)"/.exec(workbook.data.toString('utf8'));
  return xlsxToTable({
    sharedStrings: zip.get('xl/sharedStrings.xml')?.data.toString('utf8') ?? '',
    sheet: zip.get(sheetFile)?.data.toString('utf8') ?? '',
    sheetName: decodeXml(sheetNameMatch?.[1] ?? '工作表 1'),
  });
}
