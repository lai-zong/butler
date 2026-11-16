/**
 * 云端语音合成。
 *
 * 只对已登录用户开放；服务端从 TTS 角色读取连接/模型/音色，
 * 密钥永远不经过浏览器。客户端只拿音频字节。
 *
 * ★ 不把任意文本变成公开 TTS 代理：限制长度，且只由本机用户主动朗读触发。
 * ★ 音频不落盘；失败返回明确错误，由前端决定是否回退系统朗读。
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getRuntime } from '@/app/runtime';
import { findModel, findProfile, loadProfileStore, resolveProfileSecret } from '@/app/server/modelProfiles.js';
import { loadModelRoles } from '@/app/server/modelRoles.js';
import { presetById } from '@/app/server/modelPresets.js';
import { MimoTts } from '@/adapters/tts/mimo.js';
import { OpenAiTts } from '@/adapters/tts/openai.js';
import { TtsError, type TtsFormat } from '@/core/ports/tts.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_TEXT = 4_000;

interface Body {
  readonly text?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  if (typeof body.text !== 'string') {
    return NextResponse.json({ error: 'text 必须是字符串' }, { status: 400 });
  }
  const text = body.text.trim();
  if (text.length === 0) {
    return NextResponse.json({ error: '朗读文本不能为空' }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json({ error: `朗读文本最多 ${MAX_TEXT} 个字符` }, { status: 400 });
  }

  const rt = await getRuntime();
  const dir = rt.dataDir;
  const roles = await loadModelRoles(dir);
  const role = roles.tts;
  if (role === null) {
    return NextResponse.json(
      { error: '还没有配置云端语音模型。', code: 'tts_not_configured' },
      { status: 409 },
    );
  }

  const store = await loadProfileStore(dir);
  const profile = findProfile(store, role.profileId);
  const model = profile === undefined ? undefined : findModel(profile, role.modelId);
  if (profile === undefined || model === undefined || model.kind !== 'tts') {
    return NextResponse.json(
      { error: '云端语音模型配置已失效，请重新选择。', code: 'tts_not_configured' },
      { status: 409 },
    );
  }
  const preset = presetById(profile.presetId);
  if (preset === undefined || preset.kind !== 'tts') {
    return NextResponse.json(
      { error: '这条连接不是语音模型预设，请重新配置 TTS。', code: 'tts_not_configured' },
      { status: 409 },
    );
  }
  const secret = await resolveProfileSecret(profile);
  if (preset?.requiresKey === true && secret.key.length === 0) {
    return NextResponse.json(
      { error: '云端语音模型缺少 API Key。', code: 'tts_key_missing' },
      { status: 503 },
    );
  }

  const format: TtsFormat = role.format === 'wav' ? 'wav' : 'mp3';
  const signal = AbortSignal.any([
    req.signal,
    AbortSignal.timeout(60_000),
  ]);
  const port =
    preset?.adapter === 'mimo'
      ? new MimoTts({ baseUrl: profile.baseUrl, apiKey: secret.key, model: model.id })
      : new OpenAiTts({ baseUrl: profile.baseUrl, apiKey: secret.key, model: model.id });

  try {
    const result = await port.synthesize({
      text,
      voice: role.voice,
      style: role.style,
      format,
      signal,
    });
    return new Response(result.audio as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-store',
        'X-TTS-Model': result.model,
      },
    });
  } catch (err) {
    if (err instanceof TtsError) {
      if (err.code === 'aborted') {
        return NextResponse.json({ error: '朗读已取消', code: err.code }, { status: 499 });
      }
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), code: 'unknown' },
      { status: 502 },
    );
  }
}
