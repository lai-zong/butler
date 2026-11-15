import type { Metadata } from 'next';

import { LoginView } from '../ui/auth/LoginView';
import { firstSearchParam } from '../ui/auth/searchParams';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '登录 · butler',
  description: '输入这台电脑上设置的密码进入 butler。',
};

interface LoginPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps): Promise<JSX.Element> {
  const params = await searchParams;
  return <LoginView initialNext={firstSearchParam(params['next'])} />;
}
