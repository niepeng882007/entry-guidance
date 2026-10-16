import type { Metadata } from 'next';
import '../../public/style.css';

export const metadata: Metadata = {
  title: '开仓与止损卡 · 工作台',
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
