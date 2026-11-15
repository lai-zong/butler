import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalAuthError,
  changeLocalPassword,
  issueSessionToken,
  loadLocalAuth,
  localAuthPath,
  resetLocalAuthWithAnswer,
  revokeLocalSessions,
  securityQuestionOf,
  setLocalSecurityQuestion,
  setupLocalAuth,
  verifyLocalPassword,
  verifySessionToken,
} from '../localAuth.js';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'butler-local-auth-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('本地登录认证内核', () => {
  it('首次设置写入密码与安全问题哈希，不写明文', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      {
        password: 'correct horse battery',
        questionId: 'first-pet',
        answer: 'Mochi',
      },
      dir,
    );

    const raw = await readFile(localAuthPath(dir), 'utf8');
    expect(raw).not.toContain('correct horse battery');
    expect(raw).not.toContain('Mochi');
    expect(raw).not.toContain('recovery');
    expect(raw).toContain('scrypt');
    expect(raw).toContain('first-pet');

    const auth = await loadLocalAuth(dir);
    expect(auth).not.toBeNull();
    if (auth === null) return;
    expect(securityQuestionOf(auth)?.id).toBe('first-pet');

    const token = issueSessionToken(auth);
    expect(verifySessionToken(token, auth)).toBe(true);
    expect(verifySessionToken(`${token}x`, auth)).toBe(false);

    await expect(verifyLocalPassword('wrong', dir)).rejects.toMatchObject({
      code: 'invalid_password',
    });
    await expect(verifyLocalPassword('correct horse battery', dir)).resolves.toBeTruthy();
  });

  it('认证文件存在时不能再次 setup', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      { password: 'first password', questionId: 'first-pet', answer: 'mochi' },
      dir,
    );
    await expect(
      setupLocalAuth(
        { password: 'second password', questionId: 'first-pet', answer: 'mochi' },
        dir,
      ),
    ).rejects.toMatchObject({ code: 'already_configured' });
  });

  it('安全问题答案大小写/首尾空白不敏感，重置后旧会话失效', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      { password: 'first password', questionId: 'birth-city', answer: 'Beijing' },
      dir,
    );
    const before = await loadLocalAuth(dir);
    expect(before).not.toBeNull();
    if (before === null) return;
    const oldToken = issueSessionToken(before);

    const after = await resetLocalAuthWithAnswer('  BEIJING  ', 'second password', dir);
    expect(verifySessionToken(oldToken, after)).toBe(false);
    await expect(verifyLocalPassword('second password', dir)).resolves.toBeTruthy();
    await expect(verifyLocalPassword('first password', dir)).rejects.toMatchObject({
      code: 'invalid_password',
    });
  });

  it('答案错误不能重置；未设置问题时给出明确错误', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      { password: 'first password', questionId: 'first-pet', answer: 'mochi' },
      dir,
    );
    await expect(resetLocalAuthWithAnswer('wrong', 'second password', dir)).rejects.toMatchObject({
      code: 'invalid_answer',
      status: 401,
    });

    const legacy = {
      version: 1,
      password: (await loadLocalAuth(dir))?.password,
      sessionSecret: 'legacy-secret',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeFile(localAuthPath(dir), JSON.stringify(legacy), 'utf8');
    await expect(resetLocalAuthWithAnswer('mochi', 'second password', dir)).rejects.toMatchObject({
      code: 'security_not_configured',
      status: 409,
    });
  });

  it('已登录后可以补设/替换找回问题，需要当前密码', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      { password: 'first password', questionId: 'first-pet', answer: 'mochi' },
      dir,
    );
    await expect(
      setLocalSecurityQuestion('wrong', 'favorite-book', 'Dune', dir),
    ).rejects.toMatchObject({ code: 'invalid_password' });

    const auth = await setLocalSecurityQuestion('first password', 'favorite-book', 'Dune', dir);
    expect(securityQuestionOf(auth)?.id).toBe('favorite-book');
    await expect(resetLocalAuthWithAnswer('dune', 'second password', dir)).resolves.toBeTruthy();
  });

  it('修改密码会轮换会话密钥，并保留找回问题', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      { password: 'first password', questionId: 'first-pet', answer: 'mochi' },
      dir,
    );
    const before = await loadLocalAuth(dir);
    expect(before).not.toBeNull();
    if (before === null) return;
    const oldToken = issueSessionToken(before);

    const after = await changeLocalPassword('first password', 'second password', dir);
    expect(after.sessionSecret).not.toBe(before.sessionSecret);
    expect(verifySessionToken(oldToken, after)).toBe(false);
    expect(securityQuestionOf(after)?.id).toBe('first-pet');
  });

  it('退出登录会轮换密钥，旧会话立即失效', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      { password: 'first password', questionId: 'first-pet', answer: 'mochi' },
      dir,
    );
    const before = await loadLocalAuth(dir);
    expect(before).not.toBeNull();
    if (before === null) return;
    const token = issueSessionToken(before);
    expect(verifySessionToken(token, before)).toBe(true);

    await revokeLocalSessions(dir);
    const after = await loadLocalAuth(dir);
    expect(after).not.toBeNull();
    if (after === null) return;
    expect(verifySessionToken(token, after)).toBe(false);
  });

  it('损坏的认证文件 fail closed', async () => {
    const dir = await makeDir();
    await setupLocalAuth(
      { password: 'first password', questionId: 'first-pet', answer: 'mochi' },
      dir,
    );
    await writeFile(localAuthPath(dir), '{not json', 'utf8');
    await expect(loadLocalAuth(dir)).rejects.toBeInstanceOf(LocalAuthError);
    await expect(loadLocalAuth(dir)).rejects.toMatchObject({ code: 'auth_file_corrupt' });
  });

  it('拒绝过短密码与过短答案', async () => {
    const dir = await makeDir();
    await expect(
      setupLocalAuth(
        { password: 'short', questionId: 'first-pet', answer: 'mochi' },
        dir,
      ),
    ).rejects.toMatchObject({ code: 'invalid_password', status: 400 });
    await expect(
      setupLocalAuth(
        { password: 'long enough', questionId: 'first-pet', answer: 'x' },
        dir,
      ),
    ).rejects.toMatchObject({ code: 'invalid_answer', status: 400 });
  });
});
