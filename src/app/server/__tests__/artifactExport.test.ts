import { describe, expect, it } from 'vitest';

import type { Artifact, ArtifactRevision } from '../../../core/artifact/types.js';
import { artifactToCsv } from '../artifactExport.js';

const artifact: Artifact = {
  id: 'a1',
  label: '购物清单',
  kind: 'list',
  status: 'active',
  currentVersion: 1,
  producedByStep: 't1',
  createdAt: 1,
  updatedAt: 1,
};

const revision: ArtifactRevision = {
  artifactId: 'a1',
  version: 1,
  content: '苹果\n牛奶',
  items: ['苹果', '牛奶, 2 盒', '他说"好"'],
  author: 'butler',
  reason: 'test',
  producedBy: [],
  createdAt: 1,
};

describe('artifactToCsv', () => {
  it('逐条输出并正确转义逗号/引号', () => {
    const r = artifactToCsv(artifact, revision);
    expect(r.filename).toBe('购物清单.csv');
    expect(r.content).toContain('苹果');
    expect(r.content).toContain('"牛奶, 2 盒"');
    expect(r.content).toContain('"他说""好"""');
  });

  it('没有 items 时按行拆分', () => {
    const { items: _items, ...withoutItems } = revision;
    const r = artifactToCsv(artifact, {
      ...withoutItems,
      content: '第一行\n第二行',
    });
    expect(r.content).toContain('第一行');
    expect(r.content).toContain('第二行');
  });
});
