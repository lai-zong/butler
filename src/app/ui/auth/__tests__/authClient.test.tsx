/**
 * 登录前端的纯逻辑。
 *
 * 不引入 jsdom：safeNextPath / 校验 / 错误分类都是纯函数，
 * 界面文案由浏览器流程验证，这里只锁住安全边界。
 */

import { describe, expect, it } from 'vitest';

import { authFatalFrom } from '../AuthFatalView.js';
import {
  AuthRequestError,
  answerRuleError,
  passwordRuleError,
  safeNextPath,
} from '../authClient.js';
import { firstSearchParam } from '../searchParams.js';

describe('safeNextPath', () => {
  it('接受站内路径、查询串与 hash 深链', () => {
    expect(safeNextPath('/tasks?filter=due')).toBe('/#/tasks?filter=due');
    expect(safeNextPath('/#/settings')).toBe('/#/settings');
    expect(safeNextPath('/')).toBe('/');
  });

  it('拒绝外站、协议相对地址与伪协议', () => {
    expect(safeNextPath('https://evil.example/phish')).toBe('/');
    expect(safeNextPath('//evil.example/phish')).toBe('/');
    expect(safeNextPath('/\\evil.example/phish')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
  });

  it('不把登录/设置页或 API 当作回跳目标', () => {
    expect(safeNextPath('/login?next=/tasks')).toBe('/');
    expect(safeNextPath('/setup?next=/tasks')).toBe('/');
    expect(safeNextPath('/api/auth/status')).toBe('/');
    expect(safeNextPath('/tasks')).toBe('/#/tasks');
  });

  it('拒绝控制字符与空值', () => {
    expect(safeNextPath('/tasks\u0000')).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });
});

describe('passwordRuleError', () => {
  it('要求至少 8 位、最多 256 位', () => {
    expect(passwordRuleError('1234567')).toBe('密码至少 8 位');
    expect(passwordRuleError('12345678')).toBeNull();
    expect(passwordRuleError('x'.repeat(257))).toBe('密码最多 256 位');
  });
});

describe('answerRuleError', () => {
  it('答案至少 2 个字符，忽略首尾空白', () => {
    expect(answerRuleError('')).toBe('答案至少 2 个字符');
    expect(answerRuleError(' a ')).toBe('答案至少 2 个字符');
    expect(answerRuleError('猫')).toBe('答案至少 2 个字符');
    expect(answerRuleError(' 豆豆 ')).toBeNull();
    expect(answerRuleError('x'.repeat(201))).toBe('答案最多 200 个字符');
  });
});

describe('firstSearchParam', () => {
  it('只取第一个字符串参数', () => {
    expect(firstSearchParam('/tasks')).toBe('/tasks');
    expect(firstSearchParam(['/tasks', '/other'])).toBe('/tasks');
    expect(firstSearchParam([])).toBeNull();
    expect(firstSearchParam(undefined)).toBeNull();
  });
});

describe('authFatalFrom', () => {
  it('认证文件损坏才给“删文件重启”的步骤', () => {
    expect(authFatalFrom(new AuthRequestError('损坏', 503, 'auth_file_corrupt')).kind).toBe(
      'corrupt',
    );
  });

  it('读文件失败（非损坏）与网络失败分开提示', () => {
    expect(authFatalFrom(new AuthRequestError('读不了', 503, 'auth_unavailable')).kind).toBe(
      'unavailable',
    );
    expect(authFatalFrom(new AuthRequestError('连不上', 0, 'network_error')).kind).toBe('network');
  });
});
