import { connection } from 'next/server';
import RecoveryForm from './recovery-form.tsx';

export const metadata = { title: '找回密码 · 开仓与止损卡' };
export default async function Page() {
  await connection();
  return (
    <main className="page login">
      <p className="eyebrow">开仓与止损卡</p>
      <h1 className="page-title login__title">找回密码</h1>
      <p>通过邮箱接收重置链接。链接有效期为 1 小时，只能成功使用一次。</p>
      <RecoveryForm />
    </main>
  );
}
