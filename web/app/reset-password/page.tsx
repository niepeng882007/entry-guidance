import { connection } from 'next/server';
import RecoveryForm from '../forgot-password/recovery-form.tsx';

export const metadata = { title: '重置密码 · 开仓与止损卡' };
export default async function Page() {
  await connection();
  return (
    <main className="page login">
      <p className="eyebrow">开仓与止损卡</p>
      <h1 className="page-title login__title">重置密码</h1>
      <p>重置成功后，全部旧会话将退出，包括当前设备。请用新密码重新登录。</p>
      <RecoveryForm reset />
    </main>
  );
}
