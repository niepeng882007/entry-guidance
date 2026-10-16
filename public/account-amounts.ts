import { parseDecimal } from './draft.js';

export const accountDetailFields = [
  ['walletBalance', '钱包余额'],
  ['positionInitialMargin', '持仓初始保证金'],
  ['openOrderInitialMargin', '委托初始保证金'],
  ['maintMargin', '维持保证金'],
  ['maxWithdrawAmount', '可转出额'],
] as const;

export function validateAccountAmounts(data: Record<string, unknown>, details: boolean) {
  const decimal = (value: unknown) => {
    if (typeof value !== 'string' || !/^-?\d{1,24}(\.\d{1,8})?$/.test(value))
      throw new Error('账户金额无效，本次快照不可用。');
    return parseDecimal(value.replace('-', ''), '账户金额') * (value.startsWith('-') ? -1n : 1n);
  };
  for (const field of ['equity', 'availableBalance', 'walletBalance', 'unrealizedProfit'])
    decimal(data[field]);
  if (details)
    for (const [field] of accountDetailFields) if (data[field] !== null) decimal(data[field]);
  if (decimal(data.equity) !== decimal(data.walletBalance) + decimal(data.unrealizedProfit))
    throw new Error('账户权益与钱包余额、未实现盈亏不一致。');
}
