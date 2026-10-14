export const navigation = [
  { id: 'home', href: '/', title: '首页' },
  { id: 'entry', href: '/entry', title: '开仓卡' },
  { id: 'review', href: '/review', title: '交易记录分析' },
  { id: 'account', href: '/account', title: '账户快照' },
] as const;

export type AppPage = (typeof navigation)[number]['id'];
