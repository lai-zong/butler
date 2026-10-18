/**
 * `/app/settings` —— 设置
 *
 * ★ 只放**用户真的会改**的东西。
 *
 * ⚠️ 我刻意不去做"高级参数"面板（适应度权重、EMA α、休眠天数……）——
 *    那些是**调参**，不是设置。把它们摆给用户看有两个坏处：
 *      ① 大众看不懂，只会以为界面很复杂
 *      ② 摆出来就意味着"你可以调坏它"
 *
 *    它们仍然可以用环境变量改（`.env.local`），那是给开发者的入口。
 *
 * ★ 真正该给用户的只有三类：
 *   ① 看：现在用的是哪个模型（不是选，是确认）
 *   ② 读起来舒服：字号、深浅色
 *   ③ 危险操作：清空数据 —— 必须有，且必须**说清后果**
 */

import { getRuntime } from '../../runtime.js';
import { Row } from '../ui.js';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const rt = await getRuntime();
  const info = rt.model?.describe() ?? null;

  return (
      <div className="nv-scroll">
        <div className="nv-scroll-inner">
          <Section title="模型">
            {info === null ? (
              <Row
                caret=" "
                leading={<span className="nv-dot nv-dot-fail" aria-hidden />}
                label="没有配置模型"
                tail={<span style={{ color: 'var(--n-text-faint)' }}>对话不可用</span>}
              />
            ) : (
              <>
                <Row caret=" " label="当前使用" tail={<span className="nv-mono">{info.model}</span>} />
                <Row caret=" " label="服务商" tail={<span className="nv-mono">{info.provider}</span>} />
                <Row
                  caret=" "
                  label="能力"
                  tail={
                    <span className="nv-mono">
                      {info.capabilities.supportsTools ? '工具' : ''}
                      {info.capabilities.supportsStreaming ? ' · 流式' : ''}
                      {info.capabilities.supportsVision ? ' · 读图' : ''}
                    </span>
                  }
                />
              </>
            )}
            <div className="nv-note" style={{ marginTop: 'var(--n-sp-2)' }}>
              要换模型，改项目里的 <code className="nv-mono">.env.local</code>，
              把 <code className="nv-mono">DEEPSEEK_MODEL</code> 换成别的名字，然后重启。
              <br />
              界面上不提供切换 —— 换模型会让已有对话的上下文不连续，
              在聊天中途换更容易出怪事。
            </div>
          </Section>

          <Section title="外观">
            <Row
              caret=" "
              label="字号"
              tail={<span style={{ color: 'var(--n-text-faint)' }}>右上角的月亮/太阳切换深浅色</span>}
            />
            <Row
              caret=" "
              label="深浅色"
              tail={<span style={{ color: 'var(--n-text-faint)' }}>会记住你的选择</span>}
            />
            <Row
              caret=" "
              label="侧栏"
              tail={<span style={{ color: 'var(--n-text-faint)' }}>点左上角 ☰ 收起</span>}
            />
          </Section>

          <Section title="数据">
            <Row
              caret=" "
              label="存放在哪里"
              tail={<span className="nv-mono">.butler-data/</span>}
            />
            <Row
              caret=" "
              label="里面有什么"
              tail={
                <span style={{ color: 'var(--n-text-faint)' }}>
                  全部对话、记忆、操作记录
                </span>
              }
            />
            <div className="nv-note" style={{ marginTop: 'var(--n-sp-2)' }}>
              ⚠️ 这个目录里含**全部记忆与对话原文**。要备份就复制它；
              要交给别人排查问题，先想一下里面有没有不想外传的内容。
              <br />
              它不在界面上提供"一键清空" —— 那是不可逆操作，
              而放个按钮在那里，误点的代价太大。真要清就手动删目录。
            </div>
          </Section>

          <Section title="关于">
            <Row caret=" " label="管家式 AI" tail={<span className="nv-mono">v0.1.0</span>} />
            <Row
              caret=" "
              label="它怎么工作"
              tail={
                <span style={{ color: 'var(--n-text-faint)' }}>
                  管家写契约 → 自己执行 → 监督员复核
                </span>
              }
            />
          </Section>
        </div>
      </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 'var(--n-sp-5)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--n-sp-2)',
          marginBottom: 'var(--n-sp-1)',
        }}
      >
        <span style={{ fontSize: 'var(--n-fs-sub)', fontWeight: 600 }}>{title}</span>
      </div>
      {children}
    </section>
  );
}
