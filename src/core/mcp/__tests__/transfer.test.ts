import { describe, expect, it } from 'vitest';

import { buildMcpConfigExport, parseMcpConfigExport } from '../transfer.js';
import { DEFAULT_POLICY, type McpServerConfig } from '../types.js';

const server: McpServerConfig = {
  id: 'srv1',
  name: '本地搜索',
  transport: 'stdio',
  command: 'node',
  args: ['server.mjs'],
  env: { SEARCH_HOME: 'C:\\search', API_TOKEN: 'plain-looking' },
  enabled: true,
  policy: { ...DEFAULT_POLICY, level: 'readOnly', allowMemoryWrite: true },
};

describe('MCP 配置导出', () => {
  it('导出命令/参数/策略，但不导出 env 值', () => {
    const doc = buildMcpConfigExport([server], 123);
    expect(doc.schema).toBe('butler-mcp-config@1');
    expect(doc.envOmitted).toBe(true);
    expect(doc.servers[0]?.envKeys).toEqual(['API_TOKEN', 'SEARCH_HOME']);
    expect(JSON.stringify(doc)).not.toContain('C:\\\\search');
    expect(JSON.stringify(doc)).not.toContain('plain-looking');
    expect(doc.servers[0]?.policy.allowMemoryWrite).toBe(true);
  });

  it('导入导出文档可恢复非 env 配置', () => {
    const doc = buildMcpConfigExport([server], 123);
    const parsed = parseMcpConfigExport(doc);
    expect(parsed).not.toBeNull();
    expect(parsed?.rejected).toHaveLength(0);
    expect(parsed?.configs).toHaveLength(1);
    expect(parsed?.configs[0]).toMatchObject({
      id: 'srv1',
      name: '本地搜索',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
    expect(parsed?.configs[0]?.policy.level).toBe('readOnly');
  });

  it('不接受错误 schema', () => {
    expect(parseMcpConfigExport({ schema: 'other', servers: [] })).toBeNull();
  });

  it('导入仍走 validateConfig，疑似凭证会被拒绝', () => {
    const parsed = parseMcpConfigExport({
      servers: [
        {
          id: 'bad',
          name: 'bad',
          transport: 'stdio',
          command: 'node',
          env: { API_TOKEN: 'sk-123456789012345678901234567890' },
        },
      ],
    });
    expect(parsed?.configs).toHaveLength(0);
    expect(parsed?.rejected[0]?.reason).toContain('疑似凭证');
  });
});
