export function configuredOrigin(value: string | undefined): string {
  if (!value) throw new Error('缺少访问源配置。');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('访问源配置无效。');
  return url.origin;
}

export function authOrigin() {
  return configuredOrigin(process.env.AUTH_ORIGIN);
}
export function businessOrigin() {
  return configuredOrigin(process.env.BUSINESS_ORIGIN);
}

export function requestAllowed(request: Request) {
  const expected = new URL(authOrigin());
  return (
    request.headers.get('host') === expected.host &&
    (request.method === 'GET' || request.headers.get('origin') === expected.origin)
  );
}

export function authIpAddressOptions() {
  // Only trust the header overwritten by the hosting edge; local clients share one bucket.
  return { ipAddressHeaders: process.env.VERCEL === '1' ? ['x-vercel-forwarded-for'] : [] };
}
