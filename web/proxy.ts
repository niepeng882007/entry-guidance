import { NextResponse, type NextRequest } from 'next/server';
import { authOrigin, businessOrigin } from '../src/identity/config.ts';

export function proxy(request: NextRequest) {
  if (request.headers.get('host') !== new URL(authOrigin()).host)
    return new NextResponse(null, { status: 403 });
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; style-src 'self' 'nonce-${nonce}'; connect-src 'self' ${businessOrigin()}; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', csp);
  headers.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
