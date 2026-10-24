/**
 * 下载本地 embedding 模型（bge-base-zh-v1.5，q8）。
 *
 * 运行：
 *   pnpm exec tsx scripts/download-embedding-model.ts
 *
 * ⚠️ 模型约 98MB，不进 git；默认放到应用数据目录：
 *   <BUTLER_DATA_DIR 或 .butler-data>/models/Xenova/bge-base-zh-v1.5
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DATA_DIR = process.env['BUTLER_DATA_DIR'] ?? join(process.cwd(), '.butler-data');
const configuredModelRoot = process.env['BUTLER_MODEL_DIR']?.trim() ?? '';
const MODEL_ROOT =
  configuredModelRoot.length > 0 ? configuredModelRoot : join(DATA_DIR, 'models');
const MODEL_ID = 'Xenova/bge-base-zh-v1.5';
const MIRROR = 'https://hf-mirror.com';
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'] as const;

for (const file of FILES) {
  const dst = join(MODEL_ROOT, MODEL_ID, file);
  if (existsSync(dst)) {
    console.log(`✓ 已存在 ${file}`);
    continue;
  }
  await mkdir(dirname(dst), { recursive: true });
  const url = `${MIRROR}/${MODEL_ID}/resolve/main/${file}`;
  console.log(`↓ ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file} 下载失败：HTTP ${res.status}`);
  await writeFile(dst, Buffer.from(await res.arrayBuffer()));
  console.log(`✓ ${file}`);
}
console.log(`模型目录：${join(MODEL_ROOT, MODEL_ID)}`);
