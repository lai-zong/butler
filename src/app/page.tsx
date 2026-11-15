import { ButlerApp } from './ui/ButlerApp';

/**
 * 唯一页面 —— 五个空间由客户端外壳切换。
 *
 * ★ 为什么单页面而不是五条路由：
 *   对话是最重要的空间，切去看记忆时**流式任务不该被打断**。
 *   路由切换会卸载对话组件；这里用 hash 保留深链与前进后退，
 *   同时让对话层常驻。
 */
interface HomePageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HomePage({ searchParams }: HomePageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const raw = params['fromAuth'];
  const fromAuth = Array.isArray(raw) ? raw[0] : raw;
  return <ButlerApp skipBoot={fromAuth === '1'} />;
}
