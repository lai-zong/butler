import type { Metadata } from 'next';

import { SetupView } from '../ui/auth/SetupView';
import { firstSearchParam } from '../ui/auth/searchParams';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '首次设置 · butler',
  description: '为这台电脑设置本地登录密码与找回问题。',
};

interface SetupPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SetupPage({ searchParams }: SetupPageProps): Promise<JSX.Element> {
  const params = await searchParams;
  return <SetupView initialNext={firstSearchParam(params['next'])} />;
}
