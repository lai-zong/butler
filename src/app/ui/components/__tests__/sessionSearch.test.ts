import { describe, expect, it } from 'vitest';

import { filterSessionsByQuery, matchesSessionQuery } from '../sessionSearch.js';
import type { SessionSummary } from '../../lib/types.js';

function session(title: string, lastPreview = ''): SessionSummary {
  return { title, lastPreview } as SessionSummary;
}

describe('会话搜索', () => {
  it('匹配标题和最后一条消息，忽略大小写与首尾空格', () => {
    const row = session('冰箱盘点', '鸡蛋、豆腐不能吃');
    expect(matchesSessionQuery(row, '冰箱')).toBe(true);
    expect(matchesSessionQuery(row, '豆腐')).toBe(true);
    expect(matchesSessionQuery(row, '  FOO  ')).toBe(false);
    expect(matchesSessionQuery(session('FOO'), ' foo ')).toBe(true);
  });

  it('空查询返回原列表，非空只返回匹配项', () => {
    const rows = [session('冰箱盘点', '鸡蛋'), session('周报', '项目进展')];
    expect(filterSessionsByQuery(rows, '  ')).toBe(rows);
    expect(filterSessionsByQuery(rows, '周报')).toEqual([rows[1]]);
    expect(filterSessionsByQuery(rows, '不存在')).toEqual([]);
  });
});
