import { NextResponse } from 'next/server';
export function proxy() {
  const response = NextResponse.next();
  response.headers.set('x-proxy', 'native');
  return response;
}
export const config = { matcher: ['/dynamic'] };
