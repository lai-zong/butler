/**
 * 对比度检查（WCAG 2.1 AA）
 *
 * ★ 只检查**设计令牌**（文字色 × 背景色）。组件里偶尔出现的字面色
 *   不在这里硬扫 —— 那会逼着把渐变/阴影也算成文字，误报比漏报更糟。
 *   本轮修复已经把"弱文字"统一到 --ink-3 / --ink-2。
 *
 * 用法：node scripts/a11y-contrast.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = join(process.cwd(), 'src/app/styles/base.css');

function parseTokens(text) {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
  const out = {};
  for (const m of root.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function lum(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const rgb = [0, 1, 2].map((i) => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255);
  const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

const text = readFileSync(CSS, 'utf8');
const t = parseTokens(text);

const pairs = [
  ['--ink', '--paper', 4.5, '正文'],
  ['--ink-2', '--paper', 4.5, '次要正文'],
  ['--ink-3', '--paper', 4.5, '元信息（11px）'],
  ['--ink-3', '--surface', 4.5, '卡片上的元信息'],
  ['--ink-3', '--surface-2', 4.5, '卡片上的元信息（浅面）'],
  ['--accent', '--paper', 4.5, '强调色文字'],
  ['--warn', '--paper', 4.5, '警告文字'],
  ['--danger', '--paper', 4.5, '错误文字'],
  ['--ink-4', '--paper', 3.0, '非文字/大字（≥18.66px 粗体或 24px）'],
];

let failed = 0;
console.log('  对比度检查（AA：正文 4.5 / 大字 3.0）');
for (const [fg, bg, need, label] of pairs) {
  const f = t[fg];
  const b = t[bg];
  if (f === undefined || b === undefined) {
    console.log(`  ✗ ${fg} / ${bg}：令牌缺失`);
    failed += 1;
    continue;
  }
  const r = ratio(f, b);
  const ok = r >= need;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${fg} / ${bg}  ${r.toFixed(2)}:1  ≥${need}  ${label}`);
}

if (failed > 0) {
  console.log(`\n  ${failed} 项未达标`);
  process.exit(1);
}
console.log('\n  全部达标');
