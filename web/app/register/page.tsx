import Link from 'next/link';
import { connection } from 'next/server';
import Registration from './registration.tsx';
export const metadata = { title: '注册邮箱账号 · 开仓与止损卡' };
export default async function Page() {
  await connection();
  return (
    <main className="page login">
      <Link href="/" prefetch={false}>
        开仓与止损卡
      </Link>
      <h1 className="page-title login__title">注册邮箱账号</h1>
      <p>完成邮箱验证后，使用邮箱和密码登录自己的工作台。</p>
      <Registration />
    </main>
  );
}
