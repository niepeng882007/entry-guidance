import { configuredOrigin } from './config.ts';
export function siteOrigin() {
  const value = process.env.SITE_ORIGIN;
  if (!value && !['local', 'test'].includes(process.env.APP_ENV ?? 'local'))
    throw new Error('公开站点缺少 SITE_ORIGIN。');
  return configuredOrigin(value ?? 'http://127.0.0.1:3100');
}
