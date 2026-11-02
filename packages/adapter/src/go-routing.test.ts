import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeRoutes, type RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter } from 'next';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoRouteOutput } from './go-outputs';
import { GO_ROUTING_CONFIG, GO_ROUTING_ENV, getGoRouting } from './go-routing';
import adapter from './index';
import { escapeStringRegexp } from './utils';

type BuildContext = Parameters<NonNullable<NextAdapter['onBuildComplete']>>[0];
type DynamicRoute = BuildContext['routing']['dynamicRoutes'][number];

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Expected generated route');
  }
  return value;
}

function goOutput(pathname: string, basePath = ''): GoRouteOutput {
  return {
    type: 'APP_ROUTE',
    runtime: 'go',
    id: pathname,
    pathname: `${basePath}${pathname === '/' ? '' : pathname}` || '/',
    sourcePage: `${pathname === '/' ? '' : pathname}/route`,
    filePath: '/compiled-go-route',
    assets: {},
    assetsHashes: {},
    config: {},
  } as GoRouteOutput;
}

// Literal examples of the producer's public routing metadata. These fixtures
// deliberately do not import a Next matcher or generate regexes from paths.
const goMatchers: Record<string, string> = {
  '/api/items/[slug]': '^/api/items/(?<nxtPslug>[^/]+?)(?:/)?$',
  '/api/files/[...parts]': '^/api/files/(?<nxtPparts>.+?)(?:/)?$',
  '/api/files/[[...parts]]': '^/api/files(?:/(?<nxtPparts>.+?))?(?:/)?$',
  '/api/optional/[[...parts]]': '^/api/optional(?:/(?<nxtPparts>.+?))?(?:/)?$',
  '/api/[id]/data.rsc': '^/api/(?<nxtPid>[^/]+?)/data\\.rsc(?:/)?$',
  '/api/[id]/data.segments/piece.segment.rsc':
    '^/api/(?<nxtPid>[^/]+?)/data\\.segments/piece\\.segment\\.rsc(?:/)?$',
};

function producerGoRoute(source: string, basePath = ''): DynamicRoute {
  const sourceRegex = goMatchers[source];
  if (!sourceRegex) throw new Error(`Missing producer fixture: ${source}`);
  return {
    source,
    sourceRegex: sourceRegex.replace(
      '^',
      () => `^${escapeStringRegexp(basePath)}[/]?`
    ),
    destination: `${basePath}${source}`,
  };
}

function producerNodeRoute(
  source: '/api/node/[slug]' | '/api/[id]/data',
  basePath = '',
  form: 'plain' | 'collapsed' | 'rsc' = 'plain'
): DynamicRoute {
  const fixtures = {
    '/api/node/[slug]': {
      plain: '^/api/node/(?<nxtPslug>[^/]+?)(?:/)?$',
      rsc: '^/api/node/(?<nxtPslug>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$',
      collapsed:
        '^/api/node/(?<nxtPslug>[^/]+?)(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$',
      query: '?nxtPslug=$nxtPslug',
    },
    '/api/[id]/data': {
      plain: '^/api/(?<nxtPid>[^/]+?)/data(?:/)?$',
      rsc: '^/api/(?<nxtPid>[^/]+?)/data(\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$',
      collapsed:
        '^/api/(?<nxtPid>[^/]+?)/data(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$',
      query: '?nxtPid=$nxtPid',
    },
  };
  const fixture = fixtures[source];
  return {
    source: source + (form === 'rsc' ? '.rsc' : ''),
    sourceRegex: fixture[form].replace(
      '^',
      () => `^${escapeStringRegexp(basePath)}[/]?`
    ),
    destination: `${basePath}${source}${form === 'plain' ? '' : '$2'}${fixture.query}`,
  };
}

function headerValue(route: RouteWithSrc, pathname: string) {
  const matches = new RegExp(route.src).exec(pathname);
  if (!matches) return undefined;
  return route.headers?.['x-matched-path']?.replace(
    /\$([A-Za-z0-9]+)/g,
    (_, key) => matches.groups?.[key] ?? matches[Number(key)] ?? ''
  );
}

// Evaluate the emitted hit-phase configuration, including both generic Node
// header rules. This helper models rule precedence; it does not exercise HTTP
// delivery or the platform's handling of client-supplied headers.
function hitHeader(
  routes: RouteWithSrc[],
  pathname: string,
  important?: string
) {
  let value: string | undefined;
  for (const route of routes) {
    const next = headerValue(route, pathname);
    if (next === undefined) continue;
    if (route.important) important = next;
    else value ??= next;
    if (!route.continue) break;
  }
  return important ?? value;
}

function nodeHitRoutes(
  routing: ReturnType<typeof getGoRouting>,
  basePath = ''
): RouteWithSrc[] {
  return [
    {
      src: routing.nodeHitRouteSrc(
        basePath ? `${basePath}/?(?:index)?(?:/)?$` : '/(?:index)?(?:/)?$'
      ),
      headers: { 'x-matched-path': '/' },
      continue: true,
      important: true,
    },
    {
      src: routing.nodeHitRouteSrc(`${basePath}/((?!index$).*?)(?:/)?$`),
      headers: { 'x-matched-path': '/$1' },
      continue: true,
      important: true,
    },
  ];
}

describe('Go routing context', () => {
  it('forwards the producer matcher, destination and conditions with concrete context', () => {
    const output = goOutput('/api/items/[slug]', '/base');
    const source: DynamicRoute = {
      // Output selection follows the destination, not a reconstructed source.
      source: '/producer-owned-alias',
      sourceRegex:
        '^/base/(?:alias|api/items)/(?<producerCapture>[^/]+?)(?:/)?$',
      destination: '/base/api/items/[slug]?producer=value',
      has: [{ type: 'cookie', key: 'bypass', value: 'yes' }],
      missing: [{ type: 'header', key: 'skip' }],
    };
    const routing = getGoRouting([output], { basePath: '/base' });
    const route = required(routing.dynamicRoute(source));
    expect(route).toEqual({
      src: `(?<nextGoRoutePath>${source.sourceRegex})`,
      dest: source.destination,
      has: source.has,
      missing: source.missing,
      important: true,
      check: true,
      headers: { 'x-matched-path': '$nextGoRoutePath' },
    });
    for (const concrete of ['/base/api/items/a%20b', '/base/alias/a%2Fb/']) {
      const context = headerValue(route, concrete);
      expect(context).toBe(concrete);
      expect(hitHeader(routing.hitRoutes, output.pathname, context)).toBe(
        concrete
      );
    }
    expect(headerValue(route, '/base/api/items/name.rsc')).toBe(
      '/base/api/items/name.rsc'
    );
  });

  it.each([
    ['/api/files/[...parts]', '/api/files/a%2Fb/c%20d'],
    ['/api/files/[[...parts]]', '/api/files'],
    ['/api/files/[[...parts]]', '/api/files/a%2Fb/c%20d'],
  ])('preserves catch-all context for %s', (source, concrete) => {
    const routing = getGoRouting([goOutput(source)], {});
    const route = required(routing.dynamicRoute(producerGoRoute(source)));
    expect(headerValue(route, concrete)).toBe(concrete);
    expect(route.dest).toBe(source);
  });

  it('leaves non-Go destinations and producer suffix rules unchanged', () => {
    const routing = getGoRouting([goOutput('/api/items/[slug]')], {});
    expect(
      routing.dynamicRoute(
        producerNodeRoute('/api/node/[slug]', '', 'collapsed')
      )
    ).toBeUndefined();
    expect(
      routing.dynamicRoute({
        ...producerGoRoute('/api/items/[slug]'),
        destination: '/api/items/[slug].rsc?nxtPslug=$nxtPslug',
      })
    ).toBeUndefined();
    expect(
      routing.dynamicRoute({
        ...producerGoRoute('/api/items/[slug]'),
        destination: undefined,
      })
    ).toBeUndefined();
  });

  it('escapes literal paths and base paths without header or replacement interpolation', () => {
    const basePath = '/$&';
    const output = goOutput('/api/items/[slug]', basePath);
    const routing = getGoRouting(
      [output, goOutput('/literal%20/$host', basePath)],
      { basePath }
    );
    const route = required(
      routing.dynamicRoute(producerGoRoute('/api/items/[slug]', basePath))
    );
    expect(headerValue(route, '/$&/api/items/a%2Fb')).toBe(
      '/$&/api/items/a%2Fb'
    );
    expect(hitHeader(routing.hitRoutes, '/%24%26/literal%2520/%24host')).toBe(
      '/%24%26/literal%2520/%24host'
    );
  });

  it('matches escaped Unicode, space and percent function paths without intercepting percent aliases', () => {
    const routing = getGoRouting(
      [goOutput('/café with space/100%'), goOutput('/literal%20')],
      {}
    );
    expect(
      hitHeader(routing.hitRoutes, '/caf%C3%A9%20with%20space/100%25')
    ).toBe('/caf%C3%A9%20with%20space/100%25');
    expect(hitHeader(routing.hitRoutes, '/literal%20')).toBeUndefined();
    expect(hitHeader(routing.hitRoutes, '/literal%2520')).toBe('/literal%2520');
    for (const pathname of [
      '/café%20with%20space/100%',
      '/caf%c3%a9 with%20space/100%25',
      '/café with space/100%',
    ]) {
      expect(hitHeader(routing.hitRoutes, pathname)).toBe(
        '/caf%C3%A9%20with%20space/100%25'
      );
    }
    const terminal = getGoRouting(
      [goOutput('/100%'), goOutput('/literal%2G')],
      {}
    );
    expect(hitHeader(terminal.hitRoutes, '/100%')).toBe('/100%25');
    expect(hitHeader(terminal.hitRoutes, '/literal%2G')).toBe('/literal%252G');
  });

  it.each([
    ['/api/[id]/data.rsc', '/base/api/123/data.rsc'],
    [
      '/api/[id]/data.segments/piece.segment.rsc',
      '/base/api/123/data.segments/piece.segment.rsc',
    ],
  ])(
    'uses the producer matcher for a literal Go suffix artifact %s',
    (pathname, concrete) => {
      const routing = getGoRouting([goOutput(pathname, '/base')], {
        basePath: '/base',
      });
      const supplied = producerGoRoute(pathname, '/base');
      const route = required(routing.dynamicRoute(supplied));
      expect(route.src).toBe(`(?<nextGoRoutePath>${supplied.sourceRegex})`);
      expect(route.dest).toBe(supplied.destination);
      expect(headerValue(route, concrete)).toBe(concrete);
      expect(headerValue(route, `${concrete}.rsc`)).toBeUndefined();
    }
  );

  it.each([
    { basePath: '', reverse: false },
    { basePath: '', reverse: true },
    { basePath: '/base', reverse: false },
    { basePath: '/base', reverse: true },
  ])(
    'retains the last root/index alias in $basePath reverse=$reverse',
    ({ basePath, reverse }) => {
      const outputs = [goOutput('/', basePath), goOutput('/index', basePath)];
      if (reverse) outputs.reverse();
      const routing = getGoRouting(outputs, { basePath });
      expect(routing.hitRoutes).toHaveLength(1);
      for (const pathname of [basePath || '/', `${basePath}/index`]) {
        expect(hitHeader(routing.hitRoutes, pathname)).toBe(
          outputs[outputs.length - 1].pathname
        );
      }
      expect(routing.hitRoutes[0].continue).toBe(true);
      expect(routing.hitRoutes[0].important).toBeUndefined();
    }
  );

  it.each(['', '/base'])(
    'continues through valid hit routes without Node overwriting Go context (%s)',
    (basePath) => {
      const outputs = [
        goOutput('/', basePath),
        goOutput('/index', basePath),
        goOutput('/api/hello', basePath),
        goOutput('/api/items/[slug]', basePath),
        goOutput('/café with space/100%', basePath),
        goOutput('/literal%20', basePath),
      ];
      const routing = getGoRouting(outputs, { basePath });
      const nodeRules = nodeHitRoutes(routing, basePath);
      const allRules = [...routing.hitRoutes, ...nodeRules];
      expect(
        normalizeRoutes([{ handle: 'hit' }, ...allRules]).error
      ).toBeNull();
      expect(allRules.every((route) => route.continue)).toBe(true);
      for (const pathname of [
        basePath || '/',
        `${basePath}/index`,
        `${basePath}/index/`,
      ]) {
        expect(hitHeader(allRules, pathname)).toBe(`${basePath}/index`);
        expect(nodeRules.some((route) => headerValue(route, pathname))).toBe(
          false
        );
      }
      expect(hitHeader(allRules, `${basePath}/api/hello`)).toBe(
        `${basePath}/api/hello`
      );
      expect(
        hitHeader(
          allRules,
          `${basePath}/api/items/[slug]`,
          `${basePath}/api/items/new%2Fvalue`
        )
      ).toBe(`${basePath}/api/items/new%2Fvalue`);
      for (const pathname of [
        `${basePath}/café%20with%20space/100%`,
        `${basePath}/caf%c3%a9 with%20space/100%25`,
      ]) {
        expect(hitHeader(allRules, pathname)).toBe(
          `${basePath}/caf%C3%A9%20with%20space/100%25`
        );
      }
      expect(hitHeader(allRules, `${basePath}/literal%2520`)).toBe(
        `${basePath}/literal%2520`
      );
      // A raw %HH path can identify a different Node function. It must retain
      // the original Node header and capture numbering, like any Node neighbor.
      for (const pathname of [
        '/literal%20',
        '/api/node/[slug]',
        '/index-more',
      ]) {
        expect(hitHeader(allRules, `${basePath}${pathname}`)).toBe(pathname);
      }
    }
  );

  it('leaves Node hit sources unchanged without Go outputs', () => {
    const routing = getGoRouting([], {});
    for (const src of ['/(?:index)?(?:/)?$', '/((?!index$).*?)(?:/)?$']) {
      expect(routing.nodeHitRouteSrc(src)).toBe(src);
    }
    expect(hitHeader(nodeHitRoutes(routing), '/')).toBe('/');
    expect(hitHeader(nodeHitRoutes(routing), '/index')).toBe('/');
    expect(hitHeader(nodeHitRoutes(routing), '/api/node')).toBe('/api/node');
  });
});

describe('adapter-generated Go route configuration', () => {
  const roots: string[] = [];
  const savedPackager = process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH;
  const savedConfig = process.env.NEXT_ADAPTER_VERCEL_CONFIG;

  afterEach(async () => {
    for (const [key, value] of Object.entries({
      NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH: savedPackager,
      NEXT_ADAPTER_VERCEL_CONFIG: savedConfig,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  it.each(['plain', 'collapsed'] as const)(
    'generates mixed-route configuration with rewrite and hit-rule precedence (%s)',
    async (form) => {
      // Exercise onBuildComplete and inspect its files and routing rules. Live
      // query forwarding and header trust belong to HTTP deployment tests.
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'go-routing-'));
      roots.push(root);
      const distDir = path.join(root, '.next');
      const routes = [
        '/api/hello',
        '/api/items/[slug]',
        '/api/files/[...parts]',
        '/api/optional/[[...parts]]',
        '/api/[id]/data.segments/piece.segment.rsc',
      ];
      const goOutputs = [
        ...routes,
        '/',
        '/index',
        '/café with space/100%',
        '/literal%20',
      ].map((route) => goOutput(route, '/base'));
      const nodeRoute = producerNodeRoute('/api/node/[slug]', '/base', form);
      const nodeNeighbor = producerNodeRoute(
        '/api/[id]/data',
        '/base',
        form === 'plain' ? 'rsc' : form
      );
      const staticPath = path.join(distDir, 'fixture.txt');
      const binaryPath = path.join(root, 'user-server');
      const packagerPath = path.join(root, 'packager.cjs');
      await fs.mkdir(distDir, { recursive: true });
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ private: true, engines: { node: '22.x' } })
      );
      await fs.writeFile(
        path.join(distDir, 'routes-manifest.json'),
        JSON.stringify({ staticRoutes: [], dynamicRoutes: [] })
      );
      await fs.writeFile(staticPath, 'static');
      await fs.writeFile(binaryPath, 'precompiled server');
      await fs.writeFile(
        packagerPath,
        `exports.version = 1;
exports.prepareGoFunction = ({ userServerPath }) => ({
  files: {
    executable: { fsPath: userServerPath, mode: 0o755 },
    'user-server': { fsPath: userServerPath, mode: 0o755 },
  },
  config: { runtime: 'executable', handler: 'executable', runtimeLanguage: 'go',
    architecture: 'x86_64', supportsResponseStreaming: true },
});`
      );
      for (const output of goOutputs) {
        const source = path.join(root, 'app', `${output.sourcePage}.go`);
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.writeFile(source, 'package main');
        output.filePath = binaryPath;
      }
      const nodeSource = path.join(root, 'app/api/node/[slug]/route.ts');
      await fs.mkdir(path.dirname(nodeSource), { recursive: true });
      await fs.writeFile(nodeSource, 'export function GET() {}');
      const neighborSource = path.join(root, 'app/api/[id]/data/page.tsx');
      await fs.mkdir(path.dirname(neighborSource), { recursive: true });
      await fs.writeFile(neighborSource, 'export default function Page() {}');
      process.env.NEXT_ADAPTER_VERCEL_GO_PACKAGER_PATH = packagerPath;
      process.env.NEXT_ADAPTER_VERCEL_CONFIG = '{}';
      const context = {
        projectDir: root,
        repoRoot: root,
        distDir,
        buildId: 'go-routing',
        nextVersion: '16.4.0-canary.38',
        config: { basePath: '/base', pageExtensions: ['ts'], experimental: {} },
        outputs: {
          appRoutes: [
            ...goOutputs,
            {
              ...goOutput('/api/node/[slug]', '/base'),
              runtime: 'nodejs',
              filePath: nodeSource,
            },
          ],
          appPages: [
            {
              ...goOutput('/api/[id]/data', '/base'),
              type: 'APP_PAGE',
              runtime: 'nodejs',
              sourcePage: '/api/[id]/data/page',
              filePath: neighborSource,
            },
          ],
          pages: [],
          pagesApi: [],
          staticFiles: [
            {
              type: 'STATIC_FILE',
              id: 'static',
              pathname: '/base/_next/static/a.txt',
              filePath: staticPath,
            },
          ],
          prerenders: [],
        },
        routing: {
          beforeMiddleware: [],
          middlewareMatchers: [],
          beforeFiles: [
            {
              sourceRegex: '^/base/alias/(?<value>[^/]+)$',
              destination: '/base/api/items/$value?key=rewritten',
            },
          ],
          afterFiles: [],
          fallback: [],
          // The producer owns conflicts between literal Go artifacts and
          // synthetic Node suffix rules, including their final ordering.
          dynamicRoutes: [
            producerGoRoute(
              '/api/[id]/data.segments/piece.segment.rsc',
              '/base'
            ),
            nodeNeighbor,
            ...(form === 'plain'
              ? [producerNodeRoute('/api/[id]/data', '/base')]
              : []),
            ...routes.slice(1).map((route) => producerGoRoute(route, '/base')),
            nodeRoute,
          ],
          onMatch: [],
          shouldNormalizeNextData: false,
          rsc: {
            header: 'rsc',
            prefetchHeader: 'next-router-prefetch',
            prefetchSegmentHeader: 'next-router-segment-prefetch',
            prefetchSegmentDirSuffix: '.segments',
            prefetchSegmentSuffix: '.segment.rsc',
            varyHeader: 'rsc',
            contentTypeHeader: 'text/x-component',
          },
        },
      } as unknown as BuildContext;
      await required(adapter.onBuildComplete)(context);
      const generated = JSON.parse(
        await fs.readFile(path.join(distDir, 'output/config.json'), 'utf8')
      ) as { routes: RouteWithSrc[] };
      expect(normalizeRoutes(generated.routes).error).toBeNull();
      const goRules = generated.routes.filter(
        (route) => route.headers?.['x-matched-path'] === '$nextGoRoutePath'
      );
      expect(goRules).toHaveLength(5);
      const suppliedRoutes = context.routing.dynamicRoutes.map((route) => ({
        src: goOutputs.some(
          (output) => output.pathname === route.destination?.split('?')[0]
        )
          ? `(?<nextGoRoutePath>${route.sourceRegex})`
          : route.sourceRegex,
        dest: route.destination,
        check: true,
      }));
      const dynamicPhaseIndex = generated.routes.findIndex(
        (route) => 'handle' in route && route.handle === 'rewrite'
      );
      expect(
        generated.routes.slice(
          dynamicPhaseIndex + 1,
          dynamicPhaseIndex + 1 + suppliedRoutes.length
        )
      ).toEqual(
        suppliedRoutes.map((route) =>
          route.src.startsWith('(?<nextGoRoutePath>')
            ? {
                ...route,
                headers: { 'x-matched-path': '$nextGoRoutePath' },
                important: true,
              }
            : route
        )
      );
      expect(generated.routes).toContainEqual({
        src: nodeRoute.sourceRegex,
        dest: nodeRoute.destination,
        check: true,
      });
      const itemsRule = required(
        goRules.find((route) => route.dest === '/base/api/items/[slug]')
      );
      const rewrite = required(
        generated.routes.find(
          (route) => route.src === '^/base/alias/(?<value>[^/]+)$'
        )
      );
      expect(rewrite.dest).toBe('/base/api/items/$value?key=rewritten');
      expect(rewrite.headers).toEqual({
        'x-nextjs-rewritten-path': '/base/api/items/$value',
        'x-nextjs-rewritten-query': 'key=rewritten',
      });
      expect(itemsRule.dest).not.toContain('nxtP');
      const rewriteIndex = generated.routes.findIndex(
        (route) => 'handle' in route && route.handle === 'rewrite'
      );
      const dynamicRules = generated.routes
        .slice(rewriteIndex + 1)
        .filter((route) => route.check && route.src);
      const segmentPath = '/base/api/123/data.segments/piece.segment.rsc';
      const selected = required(
        dynamicRules.find((route) => new RegExp(route.src).test(segmentPath))
      );
      expect(selected.dest).toBe(
        '/base/api/[id]/data.segments/piece.segment.rsc'
      );
      expect(headerValue(selected, segmentPath)).toBe(segmentPath);
      expect(selected.dest).not.toContain('nxtP');
      const nodeSelected = required(
        dynamicRules.find((route) =>
          new RegExp(route.src).test('/base/api/123/data')
        )
      );
      expect(nodeSelected.dest).toBe(
        form === 'plain'
          ? producerNodeRoute('/api/[id]/data', '/base').destination
          : nodeNeighbor.destination
      );
      const concrete = '/base/api/items/new%20value';
      const important = headerValue(itemsRule, concrete);
      expect(important).toBe(concrete);
      const hitIndex = generated.routes.findIndex(
        (route) => 'handle' in route && route.handle === 'hit'
      );
      const hitEnd = generated.routes.findIndex(
        (route, index) => index > hitIndex && 'handle' in route
      );
      const hitRules = generated.routes.slice(hitIndex + 1, hitEnd);
      expect(hitRules.every((route) => route.continue)).toBe(true);
      expect(hitHeader(hitRules, '/base/api/items/[slug]', important)).toBe(
        concrete
      );
      expect(hitHeader(hitRules, '/base/api/hello')).toBe('/base/api/hello');
      expect(hitHeader(hitRules, '/base')).toBe('/base/index');
      expect(hitHeader(hitRules, '/base/index')).toBe('/base/index');
      expect(hitHeader(hitRules, '/base/café%20with%20space/100%')).toBe(
        '/base/caf%C3%A9%20with%20space/100%25'
      );
      expect(hitHeader(hitRules, '/base/literal%2520')).toBe(
        '/base/literal%2520'
      );
      expect(hitHeader(hitRules, '/base/literal%20')).toBe('/literal%20');
      expect(hitHeader(hitRules, '/base/api/node/[slug]')).toBe(
        '/api/node/[slug]'
      );
      const functionConfig = JSON.parse(
        await fs.readFile(
          path.join(
            distDir,
            'output/functions/base/api/items/[slug].func/.vc-config.json'
          ),
          'utf8'
        )
      );
      expect(functionConfig.environment).toEqual({
        [GO_ROUTING_ENV]: GO_ROUTING_CONFIG,
      });
      for (const name of Object.keys(functionConfig.environment)) {
        expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      }
    }
  );
});
