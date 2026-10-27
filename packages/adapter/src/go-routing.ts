import path from 'node:path';
import type { RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter, NextConfig } from 'next';
import { getNamedRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';
import type { GoRouteOutput } from './go-outputs';
import { normalizeIndexPathname } from './outputs';
import { escapeStringRegexp } from './utils';

type DynamicRoute = Parameters<
  NonNullable<NextAdapter['onBuildComplete']>
>[0]['routing']['dynamicRoutes'][number];

export const GO_ROUTING_ENV = 'NEXT_GO_ADAPTER_ROUTING';
export const GO_ROUTING_CONFIG = JSON.stringify({
  version: 1,
  pathHeader: 'x-matched-path',
});

function escapePathname(pathname: string) {
  return pathname.split('/').map(encodeURIComponent).join('/');
}

function literalPathPattern(pathname: string) {
  // Lookup decodes a request path before checking the function filesystem, but
  // rewrites can escape only part of a pathname. Match each codepoint in either
  // form, except a raw %HH alias which can identify a different function.
  const characters = Array.from(pathname);
  return characters
    .map((character, index) => {
      if (character === '/') return '/';
      const encoded = encodeURIComponent(character);
      const escaped = escapeStringRegexp(encoded).replace(
        /%[0-9A-F]{2}/g,
        (sequence) =>
          sequence.replace(/[A-F]/g, (hex) => `[${hex}${hex.toLowerCase()}]`)
      );
      if (encoded === character) return escaped;
      if (
        character === '%' &&
        /^[\da-f]{2}$/i.test(characters.slice(index + 1, index + 3).join(''))
      ) {
        return escaped;
      }
      return `(?:${escaped}|${escapeStringRegexp(character)})`;
    })
    .join('');
}

function targetsOutput(route: DynamicRoute, pathname: string) {
  const destination = route.destination?.split('?')[0];
  return (
    destination === pathname || destination?.replace(/\$\d+$/, '') === pathname
  );
}

/**
 * The platform strips client-supplied x-matched-path and always forwards the
 * routing value, including when other routing headers are filtered out. Go
 * needs the concrete escaped pathname to preserve catch-all segment boundaries;
 * the Node-only nxtP query transport decodes those boundaries before invocation.
 */
export function getGoRouting(
  outputs: readonly GoRouteOutput[],
  config: NextConfig,
  dynamicRoutes: readonly DynamicRoute[] = []
) {
  const basePath = config.basePath || '';
  const byPathname = new Map(
    outputs.map((output) => [output.pathname, output])
  );
  const ownRoutes = new Map<string, { route: DynamicRoute; index: number }>();
  dynamicRoutes.forEach((route, index) => {
    if (!route.source) return;
    const pathname = path.posix.join('/', basePath, route.source);
    if (byPathname.has(pathname) && targetsOutput(route, pathname)) {
      ownRoutes.set(pathname, { route, index });
    }
  });

  function concreteRoute(
    output: GoRouteOutput,
    route: DynamicRoute
  ): RouteWithSrc {
    const source = output.pathname.slice(basePath.length) || '/';
    const regex = getNamedRouteRegex(source, {
      prefixRouteKeys: true,
    }).namedRegex.replace('^', () => `^${escapeStringRegexp(basePath)}[/]?`);
    return {
      src: `(?<nextGoRoutePath>${regex})`,
      dest: output.pathname,
      check: true,
      has: route.has,
      missing: route.missing,
      headers: { 'x-matched-path': '$nextGoRoutePath' },
      important: true,
    };
  }

  // Keep the same winner as function materialization for root/index aliases.
  const byFunctionPath = new Map<string, GoRouteOutput>();
  for (const output of outputs) {
    byFunctionPath.set(normalizeIndexPathname(output.pathname, config), output);
  }

  const hitRoutes: RouteWithSrc[] = [...byFunctionPath].map(
    ([functionPath, output]) => ({
      src:
        functionPath === path.posix.join('/', basePath, 'index')
          ? basePath
            ? `^${literalPathPattern(basePath)}(?:/|/index/?)?$`
            : '^/(?:index/?)?$'
          : `^${literalPathPattern(functionPath)}(?:/)?$`,
      headers: {
        // This is a literal pathname, not a header interpolation template.
        // Escape each segment so percent signs and $host-like route names
        // retain their meaning when the platform expands header captures.
        'x-matched-path': escapePathname(output.pathname),
      },
      // The hit phase must continue. Node's generic important headers exclude
      // these paths, so a concrete important Go header retains precedence over
      // this normal fallback for static routes and literal template URLs.
      continue: true,
    })
  );
  const goHitPattern = hitRoutes.map((route) => route.src.slice(1)).join('|');

  return {
    hitRoutes,
    nodeHitRouteSrc(src: string) {
      if (!goHitPattern) return src;
      // Keep all groups noncapturing so the existing Node $1 header is stable.
      // Each excluded pattern is already anchored at the end of the pathname.
      return `^(?!(?:${goHitPattern}))${src.replace(/^\^/, '')}`;
    },
    beforeDynamicRoute(route: DynamicRoute): RouteWithSrc[] {
      if (ownRoutes.size === 0) return [];
      const destination = route.destination?.split('?')[0];
      if (!destination) return [];
      const prefix = destination.match(/^(.*)\$\d+$/)?.[1];
      const hasRscSuffix = route.sourceRegex.includes(
        '(\\.rsc|\\.segments/.+\\.segment\\.rsc'
      );
      const index = dynamicRoutes.indexOf(route);
      return [...ownRoutes.entries()]
        .filter(([pathname, own]) => {
          if (own.index <= index) return false;
          // Dedicated segment rules can target a Go artifact literally. The
          // generic Node RSC branch instead appends its captured suffix.
          if (pathname === destination) return true;
          if (!prefix || !hasRscSuffix) return false;
          return (
            pathname === `${prefix}.rsc` ||
            (pathname.startsWith(`${prefix}.segments/`) &&
              pathname.endsWith('.segment.rsc'))
          );
        })
        .sort(([, a], [, b]) => a.index - b.index)
        .map(([pathname, own]) => {
          const inserted = concreteRoute(
            byPathname.get(pathname) as GoRouteOutput,
            own.route
          );
          // Only move ahead when the preceding Node branch would run. Other
          // requests retain the original producer ordering and conditions.
          if (route.has?.length)
            inserted.has = [...route.has, ...(inserted.has || [])];
          if (route.missing?.length)
            inserted.missing = [...route.missing, ...(inserted.missing || [])];
          return inserted;
        });
    },
    dynamicRoute(route: DynamicRoute): RouteWithSrc | null | undefined {
      if (!route.source) return undefined;
      const pathname = path.posix.join('/', basePath, route.source);
      const candidate = byPathname.get(pathname);
      const output =
        candidate && targetsOutput(route, candidate.pathname)
          ? candidate
          : undefined;
      if (!output) {
        // Next emits synthetic RSC rules for every dynamic app entry. Go has
        // no RSC output, and a failed lookup can otherwise retain Node's nxtP
        // query parameters or replace the concrete path with a template.
        if (
          route.source.endsWith('.rsc') &&
          byPathname.has(pathname.slice(0, -4)) &&
          targetsOutput(route, pathname.slice(0, -4))
        ) {
          return null;
        }
        return undefined;
      }

      // Rebuild the plain route: Next can collapse its document and RSC rules
      // into a suffix-bearing matcher and destination, but Go emits only the
      // plain function. Named captures work in both the platform and CLI.
      return concreteRoute(output, route);
    },
  };
}
