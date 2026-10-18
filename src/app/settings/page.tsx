/**
 * `/settings` —— 设置
 *
 * ★ 只放**用户真的会改**的四类：
 *   ① 看：现在用的是哪个模型（确认，不是调参）
 *   ② 读起来舒服：深浅色在左下角，这一页只说明
 *   ③ 行为观察：同意 / 暂停 / 撤回
 *   ④ 数据：导出 / 导入
 *
 * ⚠️ 刻意不做"高级参数"面板（适应度权重、休眠天数……）：
 *    那些是调参，不是设置。摆出来只会让界面变复杂，且意味着"你可以调坏它"。
 */

import { Badge, KV, Page, Section } from '@/app/ui/primitives.js';
import { ImportData, ObservationCard } from '@/app/ui/settings-actions.js';
import { getRuntime, DATA_DIR } from '@/app/runtime';

export const dynamic = 'force-dynamic';

export default async function SettingsPage(): Promise<React.ReactElement> {
  const rt = await getRuntime();
  const model = rt.model !== null ? rt.model.describe() : null;
  const consent = rt.activityObserver.getConsent();

  return (
    <Page title="设置" desc="只放常用的几项。高级参数走环境变量，不摆在这里。">
      <Section title="模型">
        <div className="card card-pad">
          {model === null ? (
            <div className="stack">
              <div className="row">
                <Badge tone="warn">未配置</Badge>
                <span className="small muted">对话不可用，其余页面仍可使用</span>
              </div>
              <div className="small muted">
                在项目根目录的 <code>.env.local</code> 里设置：
                <pre
                  style={{
                    margin: '8px 0 0',
                    padding: '10px 12px',
                    background: 'var(--bg-soft)',
                    border: '1px solid var(--line)',
                    borderRadius: 6,
                    fontSize: 12.5,
                  }}
                >
                  DEEPSEEK_API_KEY=你的密钥{'\n'}DEEPSEEK_MODEL=deepseek-flash
                </pre>
                改完需要重启服务。
              </div>
            </div>
          ) : (
            <KV
              rows={[
                ['提供方', model.provider],
                ['模型', <code key="m">{model.model}</code>],
                [
                  '能力',
                  [
                    model.capabilities.supportsVision ? '读图' : null,
                    model.capabilities.supportsTools ? '工具调用' : null,
                    model.capabilities.supportsStreaming ? '流式' : null,
                  ]
                    .filter((x) => x !== null)
                    .join(' · ') || '仅文本',
                ],
              ]}
            />
          )}
        </div>
      </Section>

      <Section title="外观">
        <div className="card card-pad">
          <KV
            rows={[
              ['深浅色', '用左下角的按钮切换，选择会记住'],
              ['侧栏', '同样在左下角收起；收起后只留文字标签宽度'],
            ]}
          />
        </div>
      </Section>

      <Section title="行为观察">
        <ObservationCard
          initial={{
            granted: consent.granted,
            enabled: consent.enabled,
            retentionDays: consent.retentionDays,
            recordedBlocks: rt.activityObserver.rawRecords().length,
          }}
        />
      </Section>

      <Section title="数据">
        <div className="card card-pad">
          <div className="small muted" style={{ marginBottom: 12 }}>
            全部状态都在一个只追加的事件流里（<code>{DATA_DIR}</code>）。
            导出的文件可以带到另一台机器导入，导入前会自动备份。
          </div>
          <ImportData />
        </div>
      </Section>

      <Section title="关于">
        <div className="card card-pad">
          <KV
            rows={[
              ['这是做什么的', '可审计的记忆治理与自进化系统：它记得你，且你能看见它记住了什么'],
              ['数据在哪', <code key="d">{DATA_DIR}</code>],
              ['恢复摘要', rt.restoreSummary],
            ]}
          />
        </div>
      </Section>
    </Page>
  );
}
