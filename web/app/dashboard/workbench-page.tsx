import { Suspense } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentIdentity } from '../../../src/identity/auth.ts';
import Workbench from './workbench.tsx';

async function ProtectedWorkbench({
  connections,
  security,
}: {
  connections: boolean;
  security: boolean;
}) {
  let identity;
  try {
    identity = await currentIdentity(await headers());
  } catch {
    return (
      <main className="page">
        <h1 className="page-title">工作台暂时不可用</h1>
        <p role="alert">登录服务暂时不可用，请稍后刷新。</p>
      </main>
    );
  }
  if (!identity) redirect('/login');
  return <Workbench connections={connections} security={security} />;
}
export default function WorkbenchPage({
  connections = false,
  security = false,
}: {
  connections?: boolean;
  security?: boolean;
}) {
  return (
    <Suspense fallback={<p role="status">正在确认登录状态…</p>}>
      <ProtectedWorkbench connections={connections} security={security} />
    </Suspense>
  );
}
