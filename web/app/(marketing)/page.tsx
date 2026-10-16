import Link from 'next/link';
import type { Metadata } from 'next';
import { siteOrigin } from '../../../src/identity/site.ts';
import SessionLink from './session-link.tsx';

export const dynamic = 'error';
const description =
  '为 Binance USDT 本位永续合约制定开仓与止损方案，按查询时点只读核验，并保留交易记录用于复盘。交易由你在 Binance 手动执行。';
export function generateMetadata(): Metadata {
  const url = siteOrigin();
  return {
    title: '开仓与止损卡 · 从计划到复盘',
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: { title: '开仓与止损卡', description, url, type: 'website', locale: 'zh_CN' },
  };
}
export default function Page() {
  return (
    <main className="page public-site">
      <nav className="public-site__nav" aria-label="官网导航">
        <Link href="/" prefetch={false} className="public-site__brand">
          开仓与止损卡
        </Link>
        <SessionLink />
      </nav>
      <header className="public-site__intro">
        <p className="eyebrow">计划 · 执行核验 · 复盘</p>
        <h1 className="public-site__title">
          先写下风险，
          <br />
          再决定仓位。
        </h1>
        <p className="public-site__lead">
          把开仓计划、查询时点的止损核验与交易复盘连起来。交易仍由你在 Binance 手动执行。
        </p>
        <a className="button button--action-link" href="/register">
          注册邮箱账号
        </a>
        <p className="footnote">
          注册与邮箱验证已提供本地演示；多用户 Binance 绑定和业务迁移尚未完成。
        </p>
      </header>
      <section className="public-site__section" aria-labelledby="workflow-title">
        <h2 id="workflow-title">一笔交易，留下完整依据</h2>
        <dl className="public-site__workflow">
          <div>
            <dt>开仓前，固定计划</dt>
            <dd>
              从本单亏损预算与绝对止损出发确定数量；资金不足时缩量。计划亏损不等于实际亏损的保证上限。
            </dd>
          </div>
          <div>
            <dt>执行后，按时点核验</dt>
            <dd>
              对照实际持仓与有效止损委托，核对方向、数量覆盖与触发条件。数据缺失或过期时，保持未确认。
            </dd>
          </div>
          <div>
            <dt>退出后，回看执行</dt>
            <dd>
              结合订单、成交、费用和个人笔记复盘完整交易，区分交易所事实、用户自述与分析推测。
            </dd>
          </div>
        </dl>
      </section>
      <section className="public-site__section" aria-labelledby="boundary-title">
        <h2 id="boundary-title">账户读取与交易执行，各有边界</h2>
        <p>
          目标产品使用每位用户专用的 Binance
          只读凭据。工具不下单、不撤单，也不修改账户设置。查询时点核验不代表后续持续有效；止损触发价也不保证实际成交价。
        </p>
        <p>
          当前新工作台仅开放邮箱账号与个人资料。原工具的开仓、资产快照与复盘功能将按实施计划迁移。
        </p>
      </section>
      <footer className="public-site__footer">
        <span>开仓与止损卡</span>
        <a href="/login">登录工作台</a>
      </footer>
    </main>
  );
}
