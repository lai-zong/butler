/**
 * 本地登录的 HTTP 层小工具。
 *
 * 认证内核不依赖 Next；cookie 名称/属性只在这里定义一次，
 * API route 与 middleware 共用同一套常量。
 */

import type { NextRequest, NextResponse } from 'next/server';

import { LOCAL_AUTH_COOKIE, SESSION_TTL_MS } from './localAuth.js';

/** 本地 HTTP（127.0.0.1）不能设 Secure，否则 cookie 不会发送。 */
const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
} as const;

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: LOCAL_AUTH_COOKIE,
    value: token,
    ...COOKIE_BASE,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: LOCAL_AUTH_COOKIE,
    value: '',
    ...COOKIE_BASE,
    maxAge: 0,
  });
}

/**
 * 限速键。只用于本机登录；不把 x-forwarded-for 当成可信身份，
 * 只把它当成“同一来源”的粗粒度键。
 */
export function requestSourceKey(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim().length > 0) {
    return forwarded.split(',')[0]?.trim() || 'local';
  }
  return req.headers.get('x-real-ip')?.trim() || 'local';
}
