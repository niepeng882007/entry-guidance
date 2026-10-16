import Link from 'next/link';
import { connection } from 'next/server';
import Registration from '../register/registration.tsx';
export const metadata = { title: '邮箱验证 · 开仓与止损卡' };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const query = await searchParams;
  const verified = query.verified === '1' && !query.error;
  return (
    <main className="page login">
      <Link href="/" prefetch={false}>
        开仓与止损卡
      </Link>
      <h1 className="page-title login__title">{verified ? '邮箱验证完成' : '验证邮箱'}</h1>
      {verified ? (
        <>
          <p role="status">请使用邮箱和密码登录。验证链接不会自动创建登录会话。</p>
          <a className="button button--action-link" href="/login">
            前往登录
          </a>
        </>
      ) : (
        <>
          <p role={query.error ? 'alert' : undefined}>
            {query.error
              ? '验证链接无效或已过期，请重新发送验证邮件。'
              : '打开邮件中的验证链接；如果未收到邮件，可在此重发。'}
          </p>
          <Registration resendOnly />
        </>
      )}
    </main>
  );
}
