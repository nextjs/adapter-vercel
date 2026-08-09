import path from 'node:path';
import type { RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter, NextConfig } from 'next';
import { NON_HTML_SEC_FETCH_DESTS, NOT_FOUND_TXT_HEADERS } from './constants';
import { escapeStringRegexp } from './utils';

type AdapterRouting = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0]['routing'];

type AdapterRoute = AdapterRouting['beforeFiles'][0];

export const API_PATH_PREFIX_PATTERN = 'api(?:/.*|$)';

/**
 * Prevent Vercel's internal i18n routing from adding a locale prefix to
 * framework-internal assets, Pages API routes, and already-localized paths.
 */
export function getI18nPathPrefixExclusion(locales: readonly string[]): string {
  return `(?!(?:_next/.*|api|${locales
    .map((locale) => escapeStringRegexp(locale))
    .join('|')})(?:/.*|$))`;
}

export function modifyWithRewriteHeaders(
  rewrites: RouteWithSrc[],
  {
    isAfterFilesRewrite = false,
    shouldHandleSegmentPrefetches,
  }: {
    isAfterFilesRewrite?: boolean;
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

        // Filter out internal Next.js query params (nxtP* and nxtI*)
        query =
          query
            .split('&')
            .filter((part) => {
              const key = part.split('=')[0];
              return !key.startsWith('nxtP') && !key.startsWith('nxtI');
            })
            .join('&') || null;
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
            'x-nextjs-rewritten-path': pathname,
          }
        : {}),

      ...(query
        ? {
            'x-nextjs-rewritten-query': query,
          }
        : {}),
    };
  }
}

/**
 * Check if a route is a rewrite (has destination but not a redirect status)
 */
function isRewriteRoute(route: AdapterRoute): boolean {
  return Boolean(route.destination) && !isRedirectStatus(route.status);
}

/**
 * Check if a status code is a redirect status
 */
function isRedirectStatus(status: number | undefined): boolean {
  return status !== undefined && [301, 302, 303, 307, 308].includes(status);
}

/**
 * Filter and normalize rewrite routes from a routing phase
 */
export function normalizeRewrites(routing: {
  beforeFiles: AdapterRoute[];
  afterFiles: AdapterRoute[];
  fallback: AdapterRoute[];
}): {
  beforeFiles: RouteWithSrc[];
  afterFiles: RouteWithSrc[];
  fallback: RouteWithSrc[];
} {
  const normalize = (item: AdapterRoute): RouteWithSrc => ({
    src: item.sourceRegex,
    dest: item.destination,
    has: item.has,
    missing: item.missing,
    check: true,
  });

  return {
    beforeFiles: routing.beforeFiles.filter(isRewriteRoute).map((item) => {
      const route = normalize(item);
      delete route.check;
      route.continue = true;
      route.override = true;
      return route;
    }),
    afterFiles: routing.afterFiles.filter(isRewriteRoute).map(normalize),
    fallback: routing.fallback.filter(isRewriteRoute).map(normalize),
  };
}

/**
 * Extract redirect routes from routing phases
 */
export function extractRedirects(routing: {
  beforeMiddleware: AdapterRoute[];
  beforeFiles: AdapterRoute[];
}): {
  priority: RouteWithSrc[];
  normal: RouteWithSrc[];
} {
  const priorityRedirects: RouteWithSrc[] = [];
  const normalRedirects: RouteWithSrc[] = [];

  const processRedirects = (routes: AdapterRoute[]) => {
    for (const route of routes) {
      if (!isRedirectStatus(route.status)) continue;

      const vercelRoute: RouteWithSrc = {
        src: route.sourceRegex,
        headers: route.headers,
        status: route.status,
        has: route.has,
        missing: route.missing,
      };

      if (route.priority) {
        vercelRoute.continue = true;
        priorityRedirects.push(vercelRoute);
      } else {
        normalRedirects.push(vercelRoute);
      }
    }
  };

  processRedirects(routing.beforeMiddleware);
  processRedirects(routing.beforeFiles);

  return { priority: priorityRedirects, normal: normalRedirects };
}

/**
 * Extract header routes from routing phases
 */
export function extractHeaders(routing: {
  beforeMiddleware: AdapterRoute[];
  beforeFiles: AdapterRoute[];
}): RouteWithSrc[] {
  const headers: RouteWithSrc[] = [];

  const processHeaders = (routes: AdapterRoute[]) => {
    for (const route of routes) {
      // Headers have headers but are not redirects
      if (!route.headers || isRedirectStatus(route.status)) continue;
      // Skip if this is a rewrite (has destination)
      if (route.destination) continue;

      headers.push({
        src: route.sourceRegex,
        headers: route.headers,
        continue: true,
        has: route.has,
        missing: route.missing,
        ...(route.priority ? { important: true } : {}),
      });
    }
  };

  processHeaders(routing.beforeMiddleware);
  processHeaders(routing.beforeFiles);

  return headers;
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
    // remove x-nextjs-data header for non _next/data requests
    {
      src: path.posix.join('/', basePath, '/(?!_next/data(?:/|$))(.*)'),
      has: [
        {
          type: 'header',
          key: 'x-nextjs-data',
        },
      ],
      transforms: [
        {
          type: 'request.headers',
          op: 'delete',
          target: {
            key: 'x-nextjs-data',
          },
        },
      ],
      continue: true,
    },
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

/**
 * Extract onMatch routes for the hit handle phase
 */
export function extractOnMatchRoutes(routing: {
  onMatch: AdapterRoute[];
}): RouteWithSrc[] {
  return routing.onMatch.map((route) => ({
    src: route.sourceRegex,
    ...(route.destination ? { dest: route.destination } : {}),
    ...(route.headers ? { headers: route.headers } : {}),
    ...(route.has ? { has: route.has } : {}),
    ...(route.missing ? { missing: route.missing } : {}),
    continue: true,
    important: true,
  }));
}

/**
 * A route for the `error` phase that serves a plain text 404 for subresource
 * requests (images, fonts, manifests, scripts, etc.) instead of invoking the
 * app's not-found output. Must run before the fallback that dispatches to the
 * not-found output, since that dispatch matches any path.
 */
export function buildNonHtmlSecFetchDestNotFoundRoute(
  config: NextConfig
): RouteWithSrc {
  const basePath = config.basePath || '';

  return {
    src: path.posix.join(
      '/',
      basePath,
      `${basePath && basePath !== '/' ? '?' : ''}.*`
    ),
    methods: ['GET', 'HEAD'],
    has: [
      {
        type: 'header',
        key: 'sec-fetch-dest',
        value: `^(?:${NON_HTML_SEC_FETCH_DESTS.join('|')})$`,
      },
    ],
    dest: path.posix.join('/', basePath, '_next/static/not-found.txt'),
    status: 404,
    headers: NOT_FOUND_TXT_HEADERS,
  };
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
