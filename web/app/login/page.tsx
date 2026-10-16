import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import Login from './login.tsx';

async function Form() {
  await connection();
  return <Login />;
}
export default function Page() {
  return (
    <main className="page login">
      <p className="eyebrow">开仓与止损卡</p>
      <h1 className="page-title login__title">登录工作台</h1>
      <Suspense fallback={<p role="status">正在加载登录表单…</p>}>
        <Form />
      </Suspense>
      <p>
        <a href="/forgot-password">忘记密码</a> · <a href="/register">注册邮箱账号</a> ·{' '}
        <a href="/verify-email">重发验证邮件</a> ·{' '}
        <Link href="/" prefetch={false}>
          返回官网
        </Link>
      </p>
    </main>
  );
}
