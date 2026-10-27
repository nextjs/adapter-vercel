import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeRoutes, type RouteWithSrc } from '@vercel/routing-utils';
import type { NextAdapter } from 'next';
import { getNamedRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoRouteOutput } from './go-outputs';
import { GO_ROUTING_CONFIG, GO_ROUTING_ENV, getGoRouting } from './go-routing';
import adapter from './index';

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

/** Reproduce both producer routing forms, including its synthetic RSC suffix. */
function producerRoute(
  source: string,
  basePath = '',
  form: 'plain' | 'collapsed' | 'rsc' = 'plain'
): DynamicRoute {
  const { namedRegex, routeKeys } = getNamedRouteRegex(source, {
    prefixRouteKeys: true,
  });
  const suffixIndex = Object.keys(routeKeys).length + 1;
  const suffix =
    form === 'collapsed'
      ? '(\\.rsc|\\.segments/.+\\.segment\\.rsc|)(?:/)?$'
      : '(\\.rsc|\\.segments/.+\\.segment\\.rsc)(?:/)?$';
  return {
    source: source + (form === 'rsc' ? '.rsc' : ''),
    sourceRegex: (form === 'plain'
      ? namedRegex
      : namedRegex.replace('(?:/)?$', suffix)
    ).replace('^', `^${basePath}[/]?`),
    destination:
      `${basePath}${source}${form === 'plain' ? '' : `$${suffixIndex}`}?` +
      Object.entries(routeKeys)
        .map(([capture, name]) => `${name}=$${capture}`)
        .join('&'),
    has: undefined,
    missing: undefined,
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

// The platform applies important routing headers after normal ones. Exercise
// the complete emitted hit phase, including both generic Node header rules.
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
  it.each(['plain', 'collapsed'] as const)(
    'uses the resolved escaped pathname instead of Node query transport (%s)',
    (form) => {
      const output = goOutput('/api/items/[slug]', '/base');
      const source = producerRoute('/api/items/[slug]', '/base', form);
      const routing = getGoRouting([output], { basePath: '/base' });
      const route = required(routing.dynamicRoute(source));
      expect(route).toMatchObject({
        dest: '/base/api/items/[slug]',
        important: true,
        check: true,
      });
      expect(route.dest).not.toContain('?');
      const concrete = '/base/api/items/a%20b';
      const context = headerValue(route, concrete);
      expect(context).toBe(concrete);
      expect(hitHeader(routing.hitRoutes, output.pathname, context)).toBe(
        concrete
      );
      expect(headerValue(route, '/base/api/items/name.rsc')).toBe(
        '/base/api/items/name.rsc'
      );
    }
  );

  it.each([
    ['/api/files/[...parts]', '/api/files/a%2Fb/c%20d'],
    ['/api/files/[[...parts]]', '/api/files'],
    ['/api/files/[[...parts]]', '/api/files/a%2Fb/c%20d'],
  ])('preserves catch-all context for %s', (source, concrete) => {
    const routing = getGoRouting([goOutput(source)], {});
    const route = required(routing.dynamicRoute(producerRoute(source)));
    expect(headerValue(route, concrete)).toBe(concrete);
    expect(route.dest).toBe(source);
  });

  it('skips nonexistent synthetic RSC outputs and preserves other runtimes', () => {
    const routing = getGoRouting([goOutput('/api/go/[slug]')], {});
    expect(
      routing.dynamicRoute(producerRoute('/api/go/[slug]', '', 'rsc'))
    ).toBeNull();
    expect(
      routing.dynamicRoute(producerRoute('/api/node/[slug]', '', 'collapsed'))
    ).toBeUndefined();
    expect(
      routing.dynamicRoute(producerRoute('/api/edge/[slug]', '', 'collapsed'))
    ).toBeUndefined();
    expect(
      routing.dynamicRoute(producerRoute('/api/go/[slug].rsc', '', 'collapsed'))
    ).toBeUndefined();
    const explicitRsc = getGoRouting(
      [goOutput('/api/go/[slug]'), goOutput('/api/go/[slug].rsc')],
      {}
    );
    expect(
      explicitRsc.dynamicRoute(producerRoute('/api/go/[slug]', '', 'rsc'))
    ).toBeNull();
    expect(
      explicitRsc.dynamicRoute(producerRoute('/api/go/[slug].rsc'))
    ).toMatchObject({ dest: '/api/go/[slug].rsc' });
  });

  it('escapes literal paths and base paths without header or replacement interpolation', () => {
    const basePath = '/$&';
    const output = goOutput('/api/items/[slug]', basePath);
    const routing = getGoRouting(
      [output, goOutput('/literal%20/$host', basePath)],
      { basePath }
    );
    const route = required(
      routing.dynamicRoute(producerRoute('/api/items/[slug]', basePath))
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

  it.each(['plain', 'collapsed'] as const)(
    'captures actual Go artifacts before a conflicting Node RSC branch (%s)',
    (form) => {
      const node = producerRoute(
        '/api/[id]/data',
        '/base',
        form === 'plain' ? 'rsc' : form
      );
      node.has = [{ type: 'cookie', key: 'bypass', value: 'yes' }];
      node.missing = [{ type: 'header', key: 'skip' }];
      const paths = [
        '/api/[id]/data.rsc',
        '/api/[id]/data.segments/piece.segment.rsc',
      ];
      const own = paths.map((source) => producerRoute(source, '/base', form));
      const routing = getGoRouting(
        paths.map((source) => goOutput(source, '/base')),
        { basePath: '/base' },
        [node, ...own]
      );
      const inserted = routing.beforeDynamicRoute(node);
      expect(inserted).toHaveLength(2);
      for (const [index, route] of inserted.entries()) {
        const concrete = `/base${paths[index].replace('[id]', '123')}`;
        expect(headerValue(route, concrete)).toBe(concrete);
        expect(route.dest).toBe(`/base${paths[index]}`);
        expect(route.dest).not.toContain('?');
        expect(route.has).toEqual(node.has);
        expect(route.missing).toEqual(node.missing);
      }
      const plain = producerRoute('/api/[id]/data', '/base');
      expect(routing.beforeDynamicRoute(plain)).toEqual([]);
      const prefetch = getGoRouting(
        [goOutput('/api/[id]/data.prefetch.rsc', '/base')],
        { basePath: '/base' },
        [node, producerRoute('/api/[id]/data.prefetch.rsc', '/base')]
      );
      expect(prefetch.beforeDynamicRoute(node)).toEqual([]);
      const earlier = getGoRouting(
        paths.map((source) => goOutput(source, '/base')),
        { basePath: '/base' },
        [...own, node]
      );
      expect(earlier.beforeDynamicRoute(node)).toEqual([]);
    }
  );

  it('captures a Go artifact targeted by a dedicated producer segment route', () => {
    const output = goOutput('/api/[id]/data.segments/piece.segment.rsc');
    const segment: DynamicRoute = {
      source: '/api/[id]/data',
      sourceRegex:
        '^/api/(?<nxtPid>[^/]+?)/data\\.segments/piece\\.segment\\.rsc(?:/)?$',
      destination: `${output.pathname}?nxtPid=$nxtPid`,
    };
    const routing = getGoRouting([output], {}, [
      segment,
      producerRoute(output.pathname),
    ]);
    const [inserted] = routing.beforeDynamicRoute(segment);
    expect(
      headerValue(inserted, '/api/123/data.segments/piece.segment.rsc')
    ).toBe('/api/123/data.segments/piece.segment.rsc');
    expect(inserted.dest).toBe(output.pathname);
  });

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

describe('adapter-generated Go routes', () => {
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
    'packages mixed routes with trusted concrete context and original query (%s)',
    async (form) => {
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
      const nodeRoute = producerRoute('/api/node/[slug]', '/base', form);
      const nodeNeighbor = producerRoute(
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
      const neighborSource = path.join(root, 'app/api/[id]/data/route.ts');
      await fs.mkdir(path.dirname(neighborSource), { recursive: true });
      await fs.writeFile(neighborSource, 'export function GET() {}');
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
            {
              ...goOutput('/api/[id]/data', '/base'),
              runtime: 'nodejs',
              filePath: neighborSource,
            },
          ],
          appPages: [],
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
          dynamicRoutes: [
            nodeNeighbor,
            ...(form === 'plain'
              ? [producerRoute('/api/[id]/data', '/base')]
              : []),
            ...routes
              .slice(1)
              .flatMap((route) => [
                ...(form === 'plain'
                  ? [producerRoute(route, '/base', 'rsc')]
                  : []),
                producerRoute(route, '/base', form),
              ]),
            nodeRoute,
          ],
          onMatch: [],
          shouldNormalizeNextData: false,
          rsc: {
            header: 'rsc',
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
          ? producerRoute('/api/[id]/data', '/base').destination
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
    }
  );
});
