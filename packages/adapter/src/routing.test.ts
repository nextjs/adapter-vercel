import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter } from 'next';
import { describe, expect, it } from 'vitest';

import adapter from './index';
import {
  getRoutingManifestVersion,
  type RoutingManifestVersion,
} from './routing';

type BuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];

function createRouting(version?: unknown): BuildContext['routing'] {
  return {
    ...(version === undefined ? {} : { version }),
    beforeMiddleware: [],
    middlewareMatchers: [],
    beforeFiles: [],
    afterFiles: [],
    dynamicRoutes: [],
    onMatch: [],
    fallback: [],
    shouldNormalizeNextData: false,
    rsc: {
      header: 'rsc',
      varyHeader: 'rsc',
      contentTypeHeader: 'text/x-component',
    },
  } as unknown as BuildContext['routing'];
}

function createBuildContext(
  projectDir: string,
  version?: unknown
): BuildContext {
  return {
    routing: createRouting(version),
    outputs: {
      pages: [],
      appPages: [],
      pagesApi: [],
      appRoutes: [],
      prerenders: [],
      staticFiles: [],
    },
    projectDir,
    repoRoot: projectDir,
    distDir: path.join(projectDir, '.next'),
    config: {
      basePath: '/docs',
      trailingSlash: false,
      i18n: {
        locales: ['en', 'fr'],
        defaultLocale: 'en',
        localeDetection: false,
        domains: [
          {
            domain: 'example.fr',
            defaultLocale: 'fr',
          },
        ],
      },
    },
    nextVersion: 'test',
    buildId: 'test-build-id',
  } as unknown as BuildContext;
}

async function generateRoutes(
  version?: RoutingManifestVersion
): Promise<RouteWithSrc[]> {
  const projectDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'adapter-vercel-routing-')
  );

  try {
    await fs.mkdir(
      path.join(projectDir, '.next/output/static/docs/_next/static'),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(projectDir, '.next/routes-manifest.json'),
      JSON.stringify({
        version: 3,
        pages404: true,
        caseSensitive: false,
        basePath: '/docs',
        redirects: [],
        headers: [],
        onMatchHeaders: [],
        dynamicRoutes: [],
        staticRoutes: [],
        dataRoutes: [],
        rewrites: {
          beforeFiles: [],
          afterFiles: [],
          fallback: [],
        },
      })
    );
    await adapter.onBuildComplete?.(createBuildContext(projectDir, version));

    const output = JSON.parse(
      await fs.readFile(
        path.join(projectDir, '.next/output/config.json'),
        'utf8'
      )
    ) as { routes: RouteWithSrc[] };

    return output.routes;
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
}

function routeMatches(route: RouteWithSrc, pathname: string): boolean {
  if (!route.src) {
    throw new Error(`Expected route with src: ${JSON.stringify(route)}`);
  }
  return new RegExp(route.src).test(pathname);
}

function getI18nRoutes(routes: RouteWithSrc[]) {
  const wildcardPrefix = routes.find(
    (route) => route.dest === '/docs$wildcard/$1'
  );
  const defaultLocalePrefixes = routes.filter(
    (route) => route.dest === '/docs/en/$1'
  );
  const localeRemoval = routes.find((route) => route.dest === '/docs/$1');

  expect(wildcardPrefix).toBeDefined();
  expect(defaultLocalePrefixes).toHaveLength(2);
  expect(localeRemoval).toBeDefined();

  if (!wildcardPrefix || !localeRemoval) {
    throw new Error('Expected generated i18n routes');
  }

  return {
    wildcardPrefix,
    defaultLocalePrefixes,
    localeRemoval,
  };
}

describe('routing manifest versions', () => {
  it.each([
    [undefined, 1],
    [1, 1],
    [2, 2],
  ] as const)('normalizes %s to version %s', (input, expected) => {
    expect(getRoutingManifestVersion(createRouting(input))).toBe(expected);
  });

  it.each([3, 0, '2'])('rejects unsupported version %s', (version) => {
    expect(() => getRoutingManifestVersion(createRouting(version))).toThrow(
      'Unsupported Next.js routing manifest version'
    );
  });

  it('rejects unknown versions before creating deployment output', async () => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-vercel-routing-version-')
    );

    try {
      await expect(
        adapter.onBuildComplete?.(createBuildContext(projectDir, 3))
      ).rejects.toThrow('supports versions 1 and 2');
      await expect(
        fs.access(path.join(projectDir, '.next/output/config.json'))
      ).rejects.toThrow();
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe('versioned i18n Pages API routing', () => {
  it.each([
    ['unversioned', undefined],
    ['version 1', 1],
  ] as const)(
    'preserves legacy API localization for %s manifests',
    async (_, version) => {
      const routes = await generateRoutes(version);
      const { wildcardPrefix, defaultLocalePrefixes, localeRemoval } =
        getI18nRoutes(routes);

      for (const route of [wildcardPrefix, ...defaultLocalePrefixes]) {
        expect(routeMatches(route, '/docs/api')).toBe(true);
        expect(routeMatches(route, '/docs/api/users/first')).toBe(true);
        expect(routeMatches(route, '/docs/apiary')).toBe(true);
        expect(routeMatches(route, '/docs/_next/static/chunk.js')).toBe(false);
        expect(routeMatches(route, '/docs/en/blog/first')).toBe(false);
      }

      expect(routeMatches(localeRemoval, '/docs/en/api')).toBe(true);
      expect(routeMatches(localeRemoval, '/docs/en/api/users/first')).toBe(
        true
      );
      expect(routeMatches(localeRemoval, '/docs/en/apiary')).toBe(true);
      expect(routeMatches(localeRemoval, '/docs/en/blog/first')).toBe(true);
    }
  );

  it('keeps version 2 Pages API routes in the canonical namespace', async () => {
    const routes = await generateRoutes(2);
    const { wildcardPrefix, defaultLocalePrefixes, localeRemoval } =
      getI18nRoutes(routes);

    for (const route of [wildcardPrefix, ...defaultLocalePrefixes]) {
      expect(routeMatches(route, '/docs/api')).toBe(false);
      expect(routeMatches(route, '/docs/api/users/first')).toBe(false);
      expect(routeMatches(route, '/docs/apiary')).toBe(true);
      expect(routeMatches(route, '/docs/blog/first')).toBe(true);
      expect(routeMatches(route, '/docs/_next/static/chunk.js')).toBe(false);
      expect(routeMatches(route, '/docs/en/blog/first')).toBe(false);
    }

    expect(routeMatches(localeRemoval, '/docs/en/api')).toBe(false);
    expect(routeMatches(localeRemoval, '/docs/en/api/users/first')).toBe(false);
    expect(routeMatches(localeRemoval, '/docs/en/apiary')).toBe(true);
    expect(routeMatches(localeRemoval, '/docs/en/blog/first')).toBe(true);
  });
});
