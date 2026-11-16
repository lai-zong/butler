import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addSkill,
  deleteSkill,
  loadSkillStore,
  parseSkillMarkdown,
  skillsByIds,
  skillsPromptBlock,
} from '../skills.js';
import { loadSessionSkills, saveSessionSkills } from '../sessionSkills.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'butler-skills-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('技能库', () => {
  it('添加、读取、筛选和删除 Markdown 技能', async () => {
    const a = await addSkill(dir, {
      name: '周报整理',
      description: '按项目整理',
      content: '# 周报\n先读本周产出。',
    });
    const b = await addSkill(dir, { name: '资料检索', content: '先搜索再总结。' });
    expect((await loadSkillStore(dir)).map((s) => s.name)).toEqual(['周报整理', '资料检索']);
    expect((await skillsByIds(dir, [a.id, 'missing'])).map((s) => s.id)).toEqual([a.id]);
    expect(await deleteSkill(dir, b.id)).toBe(true);
    expect((await loadSkillStore(dir)).map((s) => s.name)).toEqual(['周报整理']);
  });

  it('拒绝空名称和重复名称', async () => {
    await expect(addSkill(dir, { name: ' ', content: 'x' })).rejects.toThrow('名称');
    await addSkill(dir, { name: '同名', content: 'x' });
    await expect(addSkill(dir, { name: '同名', content: 'y' })).rejects.toThrow('同名');
  });

  it('解析 frontmatter 与标题兜底', () => {
    expect(
      parseSkillMarkdown('demo.md', '---\nname: 标题\ndescription: 说明\n---\n正文'),
    ).toMatchObject({ name: '标题', description: '说明', content: '正文' });
    expect(parseSkillMarkdown('fallback.md', '# 标题兜底\n正文').name).toBe('标题兜底');
  });

  it('技能注入有总量上限并明确标记截断', () => {
    const skill = {
      id: 's',
      name: '长技能',
      description: '',
      content: 'x'.repeat(20_000),
      createdAt: 0,
      updatedAt: 0,
    };
    const block = skillsPromptBlock([skill]);
    expect(block).toContain('技能内容已截断');
    expect(block?.length).toBeLessThan(13_000);
  });

  it('会话技能 sidecar 可保存、覆盖和清空', async () => {
    expect(await loadSessionSkills(dir, 's1')).toEqual([]);
    await saveSessionSkills(dir, 's1', ['a', 'b', 'a']);
    expect(await loadSessionSkills(dir, 's1')).toEqual(['a', 'b']);
    await saveSessionSkills(dir, 's1', []);
    expect(await loadSessionSkills(dir, 's1')).toEqual([]);
  });
});
