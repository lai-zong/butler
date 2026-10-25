/**
 * Windows DPAPI 加密适配器
 *
 * ★ 为什么用 DPAPI 而不是自己生成密钥：
 *   自生成的密钥如果和密文放在同一块磁盘上，只是“看起来加密”；
 *   DPAPI 把解密能力绑定到当前 Windows 用户，才真正提高读取门槛。
 *
 * ★ 明文只通过**环境变量**传给 PowerShell，不出现在命令行参数里
 *   （命令行会被进程列表/历史记录看到）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runPowerShell(script: string, plain: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: { ...process.env, BUTLER_VAULT_PLAIN: plain },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  return stdout.trim();
}

export async function dpapiProtect(plain: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('DPAPI 只在 Windows 上可用');
  return runPowerShell(
    [
      'Add-Type -AssemblyName System.Security',
      '$b=[Text.Encoding]::UTF8.GetBytes($env:BUTLER_VAULT_PLAIN)',
      "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')",
      '[Convert]::ToBase64String($p)',
    ].join('; '),
    plain,
  );
}

export async function dpapiUnprotect(cipher: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('DPAPI 只在 Windows 上可用');
  const b64 = await runPowerShell(
    [
      'Add-Type -AssemblyName System.Security',
      '$b=[Convert]::FromBase64String($env:BUTLER_VAULT_PLAIN)',
      "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
      // 不在 PowerShell stdout 直接写中文（控制台编码会把中文变成替换字符）；
      // 先输出 UTF-8 字节的 base64，由 Node 解码。
      '[Convert]::ToBase64String($p)',
    ].join('; '),
    cipher,
  );
  return Buffer.from(b64, 'base64').toString('utf8');
}
