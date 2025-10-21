import type { NextAdapter, NextConfig } from 'next';
import type { RouteWithSrc } from '@vercel/routing-utils';

type AdapterRoutes = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0]['routes'];

export function modifyWithRewriteHeaders(
  rewrites: RouteWithSrc[],
  {
    isAfterFilesRewrite = false,
    shouldHandlePrefetchRsc,
    shouldHandleSegmentPrefetches,
  }: {
    isAfterFilesRewrite?: boolean;
    shouldHandlePrefetchRsc?: boolean;
    shouldHandleSegmentPrefetches?: boolean;
  }
) {
  for (let i = 0; i < rewrites.length; i++) {
    const rewrite = rewrites[i];

    // If this doesn't have a src or dest, we can't modify it.
    if (!rewrite.src || !rewrite.dest) continue;

    // We're not using the url.parse here because the destination is not
    // guaranteed to be a valid URL, it's a pattern, where the domain may
    // include patterns like `https://:subdomain.example.com` that would not
    // be parsed correctly.

    let protocol: string | null = null;
    if (rewrite.dest.startsWith('http://')) {
      protocol = 'http://';
    } else if (rewrite.dest.startsWith('https://')) {
      protocol = 'https://';
    }

    // We only support adding rewrite headers to routes that do not have
    // a protocol, so don't bother trying to parse the pathname if there is
    // a protocol.
    let pathname: string | null = null;
    let query: string | null = null;
    if (!protocol) {
      // Start with the full destination as the pathname. If there's a query
      // then we'll remove it.
      pathname = rewrite.dest;

      let index = pathname.indexOf('?');
      if (index !== -1) {
        query = pathname.substring(index + 1);
        pathname = pathname.substring(0, index);

        // If there's a hash, we should remove it.
        index = query.indexOf('#');
        if (index !== -1) {
          query = query.substring(0, index);
        }
      } else {
        // If there's a hash, we should remove it.
        index = pathname.indexOf('#');
        if (index !== -1) {
          pathname = pathname.substring(0, index);
        }
      }
    }

    if (isAfterFilesRewrite) {
      // ensures that userland rewrites are still correctly matched to their special outputs
      // PPR should match .prefetch.rsc, .rsc
      // non-PPR should match .rsc
      const parts = ['\\.rsc'];
      if (shouldHandlePrefetchRsc) {
        parts.push('\\.prefetch\\.rsc');
      }
      if (shouldHandleSegmentPrefetches) {
        parts.push('\\.segments/.+\\.segment\\.rsc');
      }

      const rscSuffix = parts.join('|');

      rewrite.src = rewrite.src.replace(
        /(\\\/(\?)?)?\(\?:\\\/\)\?\$$/,
        `(?:/)?(?<rscsuff>${rscSuffix})?`
      );

      const destQueryIndex = rewrite.dest.indexOf('?');
      if (destQueryIndex === -1) {
        rewrite.dest = `${rewrite.dest}$rscsuff`;
      } else {
        rewrite.dest = `${rewrite.dest.substring(
          0,
          destQueryIndex
        )}$rscsuff${rewrite.dest.substring(destQueryIndex)}`;
      }
    }

    // If the rewrite was external or didn't include a pathname or query,
    // we don't need to add the rewrite headers.
    if (protocol || (!pathname && !query)) continue;

    (rewrite as RouteWithSrc).headers = {
      ...(rewrite as RouteWithSrc).headers,

      ...(pathname
        ? {
            ['x-nextjs-rewritten-path']: pathname,
          }
        : {}),

      ...(query
        ? {
            ['x-nextjs-rewritten-query']: query,
          }
        : {}),
    };
  }
}

export function normalizeRewrites(rewrites: AdapterRoutes['rewrites']): {
  beforeFiles: RouteWithSrc[];
  afterFiles: RouteWithSrc[];
  fallback: RouteWithSrc[];
} {
  const normalize = (
    item: (typeof rewrites)['beforeFiles'][0]
  ): RouteWithSrc => ({
    src: item.sourceRegex,
    dest: item.destination,
    has: item.has,
    missing: item.missing,
    check: true,
  });

  return {
    beforeFiles: rewrites.beforeFiles.map((item) => {
      const route = normalize(item);
      delete route.check;
      route.continue = true;
      route.override = true;
      return route;
    }),
    afterFiles: rewrites.afterFiles.map(normalize),
    fallback: rewrites.fallback.map(normalize),
  };
}

export function normalizeNextDataRoutes(
  config: NextConfig,
  buildId: string,
  shouldHandleMiddlewareDataResolving: boolean,
  isOverride = false
): RouteWithSrc[] {
  if (!shouldHandleMiddlewareDataResolving) return [];

  const path = require('node:path');
  const basePath = config.basePath || '';
  const trailingSlash = config.trailingSlash || false;

  return [
    // ensure x-nextjs-data header is always present if we are doing middleware next data resolving
    {
      src: path.posix.join('/', basePath, '/_next/data/(.*)'),
      missing: [
        {
          type: 'header',
          key: 'x-nextjs-data',
        },
      ],
      transforms: [
        {
          type: 'request.headers',
          op: 'append',
          target: {
            key: 'x-nextjs-data',
          },
          args: '1',
        },
      ],
      continue: true,
    },
    // strip _next/data prefix for resolving
    {
      src: `^${path.posix.join(
        '/',
        basePath,
        '/_next/data/',
        buildId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        '/(.*).json'
      )}`,
      dest: `${path.posix.join(
        '/',
        basePath,
        '/$1',
        trailingSlash ? '/' : ''
      )}`,
      ...(isOverride ? { override: true } : {}),
      continue: true,
      has: [
        {
          type: 'header',
          key: 'x-nextjs-data',
        },
      ],
    },
    // normalize "/index" from "/_next/data/index.json" to -> just "/"
    {
      src: path.posix.join('^/', basePath, '/index(?:/)?'),
      has: [
        {
          type: 'header',
          key: 'x-nextjs-data',
        },
      ],
      dest: path.posix.join('/', basePath, trailingSlash ? '/' : ''),
      ...(isOverride ? { override: true } : {}),
      continue: true,
    },
  ];
}

export function denormalizeNextDataRoutes(
  config: NextConfig,
  buildId: string,
  shouldHandleMiddlewareDataResolving: boolean,
  isOverride = false
): RouteWithSrc[] {
  if (!shouldHandleMiddlewareDataResolving) return [];

  const path = require('node:path');
  const basePath = config.basePath || '';
  const trailingSlash = config.trailingSlash || false;

  return [
    {
      src: path.posix.join(
        '^/',
        basePath && basePath !== '/'
          ? `${basePath}${trailingSlash ? '/$' : '$'}`
          : '$'
      ),
      has: [
        {
          type: 'header',
          key: 'x-nextjs-data',
        },
      ],
      dest: `${path.posix.join(
        '/',
        basePath,
        '/_next/data/',
        buildId,
        '/index.json'
      )}`,
      continue: true,
      ...(isOverride ? { override: true } : {}),
    },
    {
      src: path.posix.join('^/', basePath, '((?!_next/)(?:.*[^/]|.*))/?$'),
      has: [
        {
          type: 'header',
          key: 'x-nextjs-data',
        },
      ],
      dest: `${path.posix.join(
        '/',
        basePath,
        '/_next/data/',
        buildId,
        '/$1.json'
      )}`,
      continue: true,
      ...(isOverride ? { override: true } : {}),
    },
  ];
}
