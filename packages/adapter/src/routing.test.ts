import type { NextConfig } from 'next';
import { describe, expect, it } from 'vitest';
import { buildNonHtmlSecFetchDestNotFoundRoute } from './routing';

function config(overrides: Partial<NextConfig> = {}): NextConfig {
  return { basePath: '', ...overrides };
}

describe('buildNonHtmlSecFetchDestNotFoundRoute', () => {
  it('only matches GET and HEAD', () => {
    const route = buildNonHtmlSecFetchDestNotFoundRoute(config());
    expect(route.methods).toEqual(['GET', 'HEAD']);
  });

  it('matches non-HTML sec-fetch-dest values and nothing else', () => {
    const route = buildNonHtmlSecFetchDestNotFoundRoute(config());
    const value = route.has?.[0];
    if (value?.type !== 'header')
      throw new Error('expected a header has clause');
    const pattern = new RegExp(String(value.value));

    for (const dest of ['image', 'font', 'manifest', 'script', 'style']) {
      expect(pattern.test(dest)).toBe(true);
    }
    for (const dest of ['document', 'iframe', 'empty', '']) {
      expect(pattern.test(dest)).toBe(false);
    }
  });

  it('serves the shared plain text not-found asset with a text/plain content type', () => {
    const route = buildNonHtmlSecFetchDestNotFoundRoute(config());
    expect(route.dest).toBe('/_next/static/not-found.txt');
    expect(route.status).toBe(404);
    expect(route.headers).toEqual({
      'content-type': 'text/plain; charset=utf-8',
    });
  });

  it('matches any path when there is no basePath', () => {
    const route = buildNonHtmlSecFetchDestNotFoundRoute(config());
    expect(new RegExp(route.src).test('/web-app-manifest-192x192.png')).toBe(
      true
    );
  });

  it('prefixes the src and dest with a configured basePath', () => {
    const route = buildNonHtmlSecFetchDestNotFoundRoute(
      config({ basePath: '/docs' })
    );
    expect(route.dest).toBe('/docs/_next/static/not-found.txt');
    expect(
      new RegExp(route.src).test('/docs/web-app-manifest-192x192.png')
    ).toBe(true);
  });
});
