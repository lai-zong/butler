/**
 * E2E 专用错误页：只用于验证根级 error boundary 真的会接管。
 * 不在导航中出现；不读写任何数据。
 */
export const dynamic = 'force-dynamic';

export default function ErrorBoundaryProbe(): never {
  throw new Error('E2E error boundary probe');
}
