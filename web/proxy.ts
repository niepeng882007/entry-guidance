import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { authOrigin, businessOrigin } from '../src/identity/config.ts';

let publicHashes: { scripts: string[]; styles: string[] } | undefined;
export function proxy(request: NextRequest) {
  if (request.headers.get('host') !== new URL(authOrigin()).host)
    return new NextResponse(null, { status: 403 });
  const publicPage = request.nextUrl.pathname === '/';
  const publicMetadata = ['/robots.txt', '/sitemap.xml'].includes(request.nextUrl.pathname);
  const production = process.env.NODE_ENV === 'production';
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  let scriptSource = `'nonce-${nonce}' 'strict-dynamic'${!production ? " 'unsafe-eval'" : ''}`;
  let styleSource = `'nonce-${nonce}'`;
  if (publicPage && production) {
    if (!publicHashes) {
      const file = [
        join(process.cwd(), 'web/generated/public-security.json'),
        join(process.cwd(), 'generated/public-security.json'),
      ].find((path) => existsSync(path));
      if (!file) return new NextResponse('官网暂时不可用。', { status: 503 });
      publicHashes = JSON.parse(readFileSync(file, 'utf8')) as typeof publicHashes;
    }
    if (!publicHashes?.scripts.length) return new NextResponse('官网暂时不可用。', { status: 503 });
    scriptSource = publicHashes.scripts.join(' ');
    styleSource = publicHashes.styles.join(' ');
  } else if (publicPage) {
    scriptSource = "'unsafe-inline' 'unsafe-eval'";
    styleSource = "'unsafe-inline'";
  }
  const csp = `default-src 'self'; script-src 'self' ${scriptSource}; style-src 'self' ${styleSource}; connect-src 'self' ${businessOrigin()}; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  if (!publicPage && !publicMetadata) {
    headers.set('Content-Security-Policy', csp);
    headers.set('x-nonce', nonce);
  }
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  if (!publicPage && !publicMetadata) response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  if ((!publicPage && !publicMetadata) || process.env.APP_ENV !== 'production')
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
