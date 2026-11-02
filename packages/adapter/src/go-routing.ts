import path from 'node:path';
import type { RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter, NextConfig } from 'next';
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

/**
 * The platform strips client-supplied x-matched-path and always forwards the
 * routing value, including when other routing headers are filtered out. Go
 * needs the concrete escaped pathname to preserve catch-all segment boundaries;
 * the Node-only nxtP query transport decodes those boundaries before invocation.
 */
export function getGoRouting(
  outputs: readonly GoRouteOutput[],
  config: NextConfig
) {
  const basePath = config.basePath || '';
  const goPathnames = new Set(outputs.map((output) => output.pathname));
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
    dynamicRoute(route: DynamicRoute): RouteWithSrc | undefined {
      const pathname = route.destination?.split('?')[0];
      if (!pathname || !goPathnames.has(pathname)) return undefined;

      // Next supplies the plain Go matcher, destination, conditions, and
      // ordering. Vercel only adds trusted concrete pathname forwarding so the
      // Go server can derive parameters without decoding catch-all boundaries.
      return {
        src: `(?<nextGoRoutePath>${route.sourceRegex})`,
        dest: route.destination,
        check: true,
        has: route.has,
        missing: route.missing,
        headers: { 'x-matched-path': '$nextGoRoutePath' },
        important: true,
      };
    },
  };
}
