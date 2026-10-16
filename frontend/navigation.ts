export const navigation = [
  { id: 'home', href: '/', title: '首页' },
  { id: 'entry', href: '/entry', title: '开仓卡' },
  { id: 'review', href: '/review', title: '交易记录' },
  { id: 'account', href: '/account', title: '我的账户' },
] as const;

export type AppPage = (typeof navigation)[number]['id'];
