'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { SectionHeading } from '../components/Common';
import { errorMessage, fetchJson, postJson } from '../lib/api.js';
import type { SkillRecord, SkillsMutationResponse, SkillsResponse, ToastMessage } from '../lib/types.js';

interface Props {
  readonly notify: (text: string, tone?: ToastMessage['tone']) => void;
}

function parseFrontmatter(fileName: string, text: string): { name: string; description: string; content: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  let name = '';
  let description = '';
  let body = normalized;
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---', 4);
    if (end >= 0) {
      const header = normalized.slice(4, end);
      body = normalized.slice(end + 4).replace(/^\n/, '');
      for (const line of header.split('\n')) {
        const match = /^\s*(name|description)\s*:\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const value = (match[2] ?? '').replace(/^["']|["']$/g, '').trim();
        if (match[1] === 'name') name = value;
        else description = value;
      }
    }
  }
  if (name.length === 0) {
    const heading = /^#\s+(.+)$/m.exec(body);
    name = heading?.[1]?.trim() ?? fileName.replace(/\.md$/i, '').trim();
  }
  return { name, description, content: body.trim() };
}

export function SkillsPanel({ notify }: Props): JSX.Element {
  const [skills, setSkills] = useState<readonly SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<SkillsResponse>('/api/skills');
      setSkills(res.skills);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(): Promise<void> {
    if (name.trim().length === 0 || content.trim().length === 0) {
      setError('技能名称和说明不能为空。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await postJson<SkillsMutationResponse>('/api/skills', {
        action: 'add',
        name,
        description,
        content,
      });
      setSkills(res.skills);
      setName('');
      setDescription('');
      setContent('');
      notify('技能已添加', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await postJson<SkillsMutationResponse>('/api/skills', { action: 'delete', id });
      setSkills(res.skills);
      notify('技能已删除', 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File): Promise<void> {
    if (file.size > 64 * 1024) {
      setError('技能文件不能超过 64 KB。');
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseFrontmatter(file.name, text);
      setName(parsed.name);
      setDescription(parsed.description);
      setContent(parsed.content);
      setError(null);
      notify('已读取 Markdown，确认后点击添加', 'success');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="panel settings-panel">
      <SectionHeading
        title="技能库"
        description="V1 只支持 Markdown 说明型技能：导入后可在对话设置里启用。不会执行脚本，也不会绕过工具权限。"
      />

      <div className="model-form-head">
        <div>
          <h3>添加技能</h3>
          <p>可直接粘贴 Markdown，或导入一个带 frontmatter 的 .md 文件。</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void importFile(file);
            event.target.value = '';
          }}
        />
        <button type="button" className="model-ghost" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" size={13} /> 导入 .md
        </button>
      </div>

      <div className="model-form-grid">
        <label className="model-field">
          <span>名称</span>
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="例如：周报整理" />
        </label>
        <label className="model-field">
          <span>描述</span>
          <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明适用场景" />
        </label>
      </div>
      <label className="model-field">
        <span>技能说明（Markdown）</span>
        <textarea
          rows={8}
          value={content}
          maxLength={30_000}
          onChange={(e) => setContent(e.target.value)}
          placeholder={'# 周报整理\n\n先收集本周对话和产出，再按项目、进展、风险整理。'}
        />
      </label>
      <div className="tts-role-actions">
        <button type="button" className="model-primary" disabled={busy} onClick={() => void add()}>
          {busy ? '处理中…' : '添加技能'}
        </button>
      </div>

      {error !== null && <p className="model-error">{error}</p>}

      <div className="model-model-section">
        <div className="model-model-head">
          <div>
            <strong>已添加的技能</strong>
            <p>{loading ? '正在读取…' : `${skills.length} 个技能`}</p>
          </div>
          <button type="button" className="model-ghost" disabled={loading} onClick={() => void load()}>
            刷新
          </button>
        </div>
        {!loading && skills.length === 0 ? (
          <p className="model-empty">还没有技能。添加一个 Markdown 技能后，就能在对话设置里启用。</p>
        ) : (
          <div className="model-results" style={{ maxHeight: 360 }}>
            {skills.map((skill) => (
              <div className="model-result" key={skill.id} style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{skill.name}</strong>
                  <p className="model-muted">{skill.description.length > 0 ? skill.description : '没有描述'}</p>
                  <code>{skill.id}</code>
                </div>
                <button type="button" className="model-ghost" disabled={busy} onClick={() => void remove(skill.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
