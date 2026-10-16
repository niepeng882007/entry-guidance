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
    </main>
  );
}
