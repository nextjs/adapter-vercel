import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getHandlerSource } from './node-handler';

const require = createRequire(import.meta.url);

type Invocation = {
  url: string;
  requestMeta: {
    initURL?: string;
    minimalMode?: boolean;
  };
};

type LauncherModule = (
  req: {
    url: string;
    method: string;
    headers: Record<string, string>;
  },
  res: {
    statusCode: number;
    body?: string;
    setHeader: (key: string, value: string) => void;
    end: (body?: string) => void;
  },
  internalMetadata: Record<string, unknown>
) => Promise<void>;

describe('node handler route captures', () => {
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const projectDirs: string[] = [];

  afterEach(async () => {
    process.chdir(originalCwd);

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    await Promise.all(
      projectDirs
        .splice(0)
        .map((projectDir) =>
          fs.rm(projectDir, { recursive: true, force: true })
        )
    );
  });

  async function setupRoute({
    routePage,
    namedRegex,
    routeKeys,
  }: {
    routePage: string;
    namedRegex: string;
    routeKeys: Record<string, string>;
  }) {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-node-handler-')
    );
    projectDirs.push(projectDir);

    const distDir = path.join(projectDir, '.next');
    await fs.mkdir(path.join(distDir, 'server', 'app', routePage), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, 'node_modules', 'next'), {
      recursive: true,
    });

    await fs.writeFile(
      path.join(distDir, 'routes-manifest.json'),
      JSON.stringify({
        staticRoutes: [],
        dynamicRoutes: [
          {
            page: routePage,
            regex: namedRegex,
            namedRegex,
            routeKeys,
          },
        ],
      })
    );
    await fs.writeFile(
      path.join(distDir, 'app-path-routes-manifest.json'),
      JSON.stringify({
        [`${routePage}/page`]: routePage,
      })
    );
    await fs.writeFile(
      path.join(distDir, 'server', 'app', routePage, 'page.js'),
      `module.exports.handler = async (req, res, ctx) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ url: req.url, requestMeta: ctx.requestMeta }));
      };`
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'package.json'),
      JSON.stringify({ name: 'next', main: 'setup-node-env.js' })
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'setup-node-env.js'),
      ''
    );

    const launcherPath = path.join(projectDir, 'launcher.cjs');
    await fs.writeFile(
      launcherPath,
      getHandlerSource({
        projectRelativeDistDir: '.next',
        prerenderFallbackFalseMap: {},
        nextConfig: {},
      })
    );

    const launcher = require(launcherPath) as LauncherModule;

    return async function invoke({
      url,
      matchedPath,
    }: {
      url: string;
      matchedPath: string;
    }): Promise<Invocation> {
      const response = {
        statusCode: 0,
        body: undefined as string | undefined,
        headers: {} as Record<string, string>,
        setHeader(key: string, value: string) {
          this.headers[key] = value;
        },
        end(body?: string) {
          this.body = body;
        },
      };

      await launcher(
        {
          url,
          method: 'GET',
          headers: {
            host: 'example.test',
            'x-matched-path': matchedPath,
          },
        },
        response,
        {}
      );

      expect(response.statusCode).toBe(200);
      if (response.body === undefined) {
        throw new Error('The page stub did not write a response body.');
      }
      return JSON.parse(response.body) as Invocation;
    };
  }

  function setupOptionalCatchallRoute() {
    return setupRoute({
      routePage: '/[locale]/[[...filterSlugs]]',
      namedRegex: '^/(?<nxtPlocale>[^/]+?)(?:/(?<nxtPfilterSlugs>.+?))?(?:/)?$',
      routeKeys: {
        nxtPlocale: 'nxtPlocale',
        nxtPfilterSlugs: 'nxtPfilterSlugs',
      },
    });
  }

  it('recovers concrete parent params without synthesizing an omitted optional catch-all', async () => {
    const invoke = await setupOptionalCatchallRoute();

    const invocation = await invoke({
      url: '/en/[[...filterSlugs]]',
      matchedPath: '/en/[[...filterSlugs]]',
    });

    expect(invocation.url).toBe('/en/[[...filterSlugs]]?nxtPlocale=en');
    expect(invocation.requestMeta.initURL).toBe(
      'https://example.test/en/[[...filterSlugs]]'
    );
  });

  it.each([
    ['/en?nxtPfilterSlugs=', '/en?nxtPfilterSlugs=&nxtPlocale=en'],
    [
      '/en/one?nxtPfilterSlugs=one',
      '/en/one?nxtPfilterSlugs=one&nxtPlocale=en',
    ],
    [
      '/en/two/three?nxtPfilterSlugs=two%2Fthree',
      '/en/two/three?nxtPfilterSlugs=two%2Fthree&nxtPlocale=en',
    ],
  ])(
    'preserves an existing optional catch-all query value for %s',
    async (url, expected) => {
      const invoke = await setupOptionalCatchallRoute();

      const invocation = await invoke({
        url,
        matchedPath: '/en/[[...filterSlugs]]',
      });

      expect(invocation.url).toBe(expected);
      expect(invocation.requestMeta.initURL).toBe(`https://example.test${url}`);
    }
  );

  it('does not synthesize over a public query parameter with the route param name', async () => {
    const invoke = await setupOptionalCatchallRoute();

    const invocation = await invoke({
      url: '/en/[[...filterSlugs]]?filterSlugs=books',
      matchedPath: '/en/[[...filterSlugs]]',
    });

    expect(invocation.url).toBe(
      '/en/[[...filterSlugs]]?filterSlugs=books&nxtPlocale=en'
    );
  });

  it('preserves a platform-supplied placeholder query parameter', async () => {
    const invoke = await setupOptionalCatchallRoute();

    const invocation = await invoke({
      url: '/en/[[...filterSlugs]]?nxtPfilterSlugs=[[...filterSlugs]]',
      matchedPath: '/en/[[...filterSlugs]]',
    });

    expect(invocation.url).toBe(
      '/en/[[...filterSlugs]]?nxtPfilterSlugs=%5B%5B...filterSlugs%5D%5D&nxtPlocale=en'
    );
  });

  it('leaves other template-looking catch-all values in place', async () => {
    const invoke = await setupOptionalCatchallRoute();

    const invocation = await invoke({
      url: '/en/[[...other]]',
      matchedPath: '/en/[[...other]]',
    });

    expect(invocation.url).toBe(
      '/en/[[...other]]?nxtPlocale=en&nxtPfilterSlugs=%5B%5B...other%5D%5D'
    );
  });

  it('uses routeKeys to identify a cleaned capture name', async () => {
    const invoke = await setupRoute({
      routePage: '/[locale]/[[...filter-slugs]]',
      namedRegex: '^/(?<nxtPlocale>[^/]+?)(?:/(?<nxtPfilterslugs>.+?))?(?:/)?$',
      routeKeys: {
        nxtPlocale: 'nxtPlocale',
        nxtPfilterslugs: 'nxtPfilter-slugs',
      },
    });

    const invocation = await invoke({
      url: '/en/[[...filter-slugs]]',
      matchedPath: '/en/[[...filter-slugs]]',
    });

    expect(invocation.url).toBe('/en/[[...filter-slugs]]?nxtPlocale=en');
  });

  it.each([
    [
      'required',
      '/[locale]/[slug]',
      '^/(?<nxtPlocale>[^/]+?)/(?<nxtPslug>[^/]+?)(?:/)?$',
      '/en/[slug]',
      '/en/[slug]?nxtPlocale=en&nxtPslug=%5Bslug%5D',
    ],
    [
      'repeated',
      '/[locale]/[...slug]',
      '^/(?<nxtPlocale>[^/]+?)/(?<nxtPslug>.+?)(?:/)?$',
      '/en/[...slug]',
      '/en/[...slug]?nxtPlocale=en&nxtPslug=%5B...slug%5D',
    ],
  ])(
    'preserves %s template captures for fallback generation',
    async (_name, routePage, namedRegex, matchedPath, expected) => {
      const invoke = await setupRoute({
        routePage,
        namedRegex,
        routeKeys: {
          nxtPlocale: 'nxtPlocale',
          nxtPslug: 'nxtPslug',
        },
      });

      const invocation = await invoke({ url: matchedPath, matchedPath });

      expect(invocation.url).toBe(expected);
    }
  );

  it('does not add captures for an exact route-template match', async () => {
    const invoke = await setupOptionalCatchallRoute();
    const url =
      '/[locale]/[[...filterSlugs]]?nxtPlocale=other&nxtPfilterSlugs=two%2Fthree';

    const invocation = await invoke({
      url,
      matchedPath: '/[locale]/[[...filterSlugs]]',
    });

    expect(invocation.url).toBe(url);
  });
});

describe('node handler proxy loading', () => {
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const projectDirs: string[] = [];

  afterEach(async () => {
    process.chdir(originalCwd);
    delete (globalThis as { __proxyLoads?: number }).__proxyLoads;

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    await Promise.all(
      projectDirs
        .splice(0)
        .map((projectDir) =>
          fs.rm(projectDir, { recursive: true, force: true })
        )
    );
  });

  async function setupProxy(proxySource: string) {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-node-handler-proxy-')
    );
    projectDirs.push(projectDir);

    await fs.mkdir(path.join(projectDir, '.next', 'server'), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, 'node_modules', 'next'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, '.next', 'server', 'middleware.js'),
      proxySource
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'package.json'),
      JSON.stringify({ name: 'next', main: 'setup-node-env.js' })
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'setup-node-env.js'),
      ''
    );

    const launcherPath = path.join(projectDir, 'launcher.cjs');
    await fs.writeFile(
      launcherPath,
      getHandlerSource({
        projectRelativeDistDir: '.next',
        prerenderFallbackFalseMap: {},
        isMiddleware: true,
      })
    );

    return () =>
      require(launcherPath) as (request: Request) => Promise<Response>;
  }

  it('loads the proxy when the function initializes', async () => {
    const loadLauncher = await setupProxy(
      `globalThis.__proxyLoads = (globalThis.__proxyLoads || 0) + 1;
      module.exports.handler = async () => new Response('from proxy');`
    );

    const handler = loadLauncher();
    expect((globalThis as { __proxyLoads?: number }).__proxyLoads).toBe(1);

    const response = await handler(new Request('https://example.test/'));
    expect(await response.text()).toBe('from proxy');
    expect((globalThis as { __proxyLoads?: number }).__proxyLoads).toBe(1);
  });

  it('reports a proxy that fails to load on the request instead of on initialization', async () => {
    const loadLauncher = await setupProxy(
      `throw new Error('proxy failed to load');`
    );

    const handler = loadLauncher();

    await expect(handler(new Request('https://example.test/'))).rejects.toThrow(
      'proxy failed to load'
    );
  });

  it('reports an async proxy that fails to load on the request', async () => {
    const loadLauncher = await setupProxy(
      `module.exports = Promise.reject(new Error('async proxy failed to load'));`
    );

    const handler = loadLauncher();

    await expect(handler(new Request('https://example.test/'))).rejects.toThrow(
      'async proxy failed to load'
    );
  });
});

describe('node handler basePath without x-matched-path', () => {
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const projectDirs: string[] = [];
  const basePath = '/docs';

  afterEach(async () => {
    process.chdir(originalCwd);

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    await Promise.all(
      projectDirs
        .splice(0)
        .map((projectDir) =>
          fs.rm(projectDir, { recursive: true, force: true })
        )
    );
  });

  // Each app entry maps a route (as Next.js reports it, without basePath) to
  // its entry file under `.next/server/app`, e.g. `/foo` -> `/foo/route`.
  async function setupApp(entries: Record<string, string>) {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-node-handler-base-path-')
    );
    projectDirs.push(projectDir);

    const distDir = path.join(projectDir, '.next');
    await fs.mkdir(path.join(projectDir, 'node_modules', 'next'), {
      recursive: true,
    });

    const appPathRoutes: Record<string, string> = {};
    for (const [route, entry] of Object.entries(entries)) {
      appPathRoutes[entry] = route;
      const entryFile = path.join(distDir, 'server', 'app', `${entry}.js`);
      await fs.mkdir(path.dirname(entryFile), { recursive: true });
      await fs.writeFile(
        entryFile,
        `module.exports.handler = async (req, res) => {
          res.statusCode = 200;
          res.end(JSON.stringify({ entry: ${JSON.stringify(entry)}, url: req.url }));
        };`
      );
    }

    await fs.writeFile(
      path.join(distDir, 'routes-manifest.json'),
      JSON.stringify({
        staticRoutes: Object.keys(entries).map((page) => ({
          page,
          regex: `^${page}(?:/)?$`,
          namedRegex: `^${page}(?:/)?$`,
          routeKeys: {},
        })),
        dynamicRoutes: [],
      })
    );
    await fs.writeFile(
      path.join(distDir, 'app-path-routes-manifest.json'),
      JSON.stringify(appPathRoutes)
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'package.json'),
      JSON.stringify({ name: 'next', main: 'setup-node-env.js' })
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'setup-node-env.js'),
      ''
    );

    const launcherPath = path.join(projectDir, 'launcher.cjs');
    await fs.writeFile(
      launcherPath,
      getHandlerSource({
        projectRelativeDistDir: '.next',
        prerenderFallbackFalseMap: {},
        nextConfig: { basePath },
      })
    );

    const launcher = require(launcherPath) as LauncherModule;

    return async function invoke({
      url,
      matchedPath,
    }: {
      url: string;
      matchedPath?: string;
    }): Promise<{ entry: string; url: string }> {
      const response = {
        statusCode: 0,
        body: undefined as string | undefined,
        setHeader() {},
        end(body?: string) {
          this.body = body;
        },
      };
      const headers: Record<string, string> = { host: 'example.test' };
      if (matchedPath !== undefined) {
        headers['x-matched-path'] = matchedPath;
      }

      await launcher({ url, method: 'POST', headers }, response, {});

      expect(response.statusCode).toBe(200);
      if (response.body === undefined) {
        throw new Error('The entry stub did not write a response body.');
      }
      return JSON.parse(response.body) as { entry: string; url: string };
    };
  }

  it('resolves an app route from a basePath-prefixed URL', async () => {
    const invoke = await setupApp({ '/api/queue': '/api/queue/route' });

    const invocation = await invoke({ url: `${basePath}/api/queue` });

    expect(invocation.entry).toBe('/api/queue/route');
    expect(invocation.url).toBe(`${basePath}/api/queue`);
  });

  it('resolves the root page from the bare basePath', async () => {
    const invoke = await setupApp({ '/': '/page' });

    const invocation = await invoke({ url: basePath });

    expect(invocation.entry).toBe('/page');
  });

  it('keeps x-matched-path as the source of truth when present', async () => {
    const invoke = await setupApp({
      '/api/queue': '/api/queue/route',
      [`${basePath}/api/queue`]: `${basePath}/api/queue/route`,
    });

    const invocation = await invoke({
      url: `${basePath}${basePath}/api/queue`,
      matchedPath: `${basePath}/api/queue`,
    });

    expect(invocation.entry).toBe(`${basePath}/api/queue/route`);
  });

  it('only strips the basePath at a segment boundary', async () => {
    const invoke = await setupApp({
      [`${basePath}-archive`]: `${basePath}-archive/route`,
    });

    const invocation = await invoke({ url: `${basePath}-archive` });

    expect(invocation.entry).toBe(`${basePath}-archive/route`);
  });
});

describe('node handler page lookup', () => {
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const OriginalRegExp = globalThis.RegExp;
  const projectDirs: string[] = [];

  afterEach(async () => {
    globalThis.RegExp = OriginalRegExp;
    process.chdir(originalCwd);

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    await Promise.all(
      projectDirs
        .splice(0)
        .map((projectDir) =>
          fs.rm(projectDir, { recursive: true, force: true })
        )
    );
  });

  type DynamicRoute = {
    page: string;
    regex: string;
    namedRegex: string;
    routeKeys: Record<string, string>;
  };
  const BLOG: DynamicRoute = {
    page: '/blog/[slug]',
    regex: '^/blog/([^/]+?)(?:/)?$',
    namedRegex: '^/blog/(?<nxtPslug>[^/]+?)(?:/)?$',
    routeKeys: { nxtPslug: 'nxtPslug' },
  };
  const CATCH_ALL: DynamicRoute = {
    page: '/[...all]',
    regex: '^/(.+?)(?:/)?$',
    namedRegex: '^/(?<nxtPall>.+?)(?:/)?$',
    routeKeys: { nxtPall: 'nxtPall' },
  };

  // `entries` maps a page to its entry file under `.next/server`, e.g.
  // `/blog/[slug]` -> `app/blog/[slug]/page`.
  async function setupApp({
    entries,
    dynamicRoutes = [],
    i18n,
    prerenderFallbackFalseMap = {},
  }: {
    entries: Record<string, string>;
    dynamicRoutes?: DynamicRoute[];
    i18n?: { locales: string[]; defaultLocale: string };
    prerenderFallbackFalseMap?: Record<string, string[]>;
  }) {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-node-handler-lookup-')
    );
    projectDirs.push(projectDir);

    const distDir = path.join(projectDir, '.next');
    await fs.mkdir(path.join(projectDir, 'node_modules', 'next'), {
      recursive: true,
    });

    const appPathRoutes: Record<string, string> = {};
    for (const [page, entry] of Object.entries(entries)) {
      if (entry.startsWith('app/')) {
        appPathRoutes[entry.slice('app'.length)] = page;
      }
      const entryFile = path.join(distDir, 'server', `${entry}.js`);
      await fs.mkdir(path.dirname(entryFile), { recursive: true });
      await fs.writeFile(
        entryFile,
        `module.exports.handler = async (req, res, ctx) => {
          res.statusCode = 200;
          res.end(JSON.stringify({ entry: ${JSON.stringify(entry)}, url: req.url, locale: ctx.requestMeta.locale }));
        };`
      );
    }

    const dynamicPages = new Set(dynamicRoutes.map((route) => route.page));
    await fs.writeFile(
      path.join(distDir, 'routes-manifest.json'),
      JSON.stringify({
        staticRoutes: Object.keys(entries)
          .filter((page) => !dynamicPages.has(page))
          .map((page) => ({
            page,
            regex: `^${page}(?:/)?$`,
            namedRegex: `^${page}(?:/)?$`,
            routeKeys: {},
          })),
        dynamicRoutes,
        i18n,
      })
    );
    await fs.writeFile(
      path.join(distDir, 'app-path-routes-manifest.json'),
      JSON.stringify(appPathRoutes)
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'package.json'),
      JSON.stringify({ name: 'next', main: 'setup-node-env.js' })
    );
    await fs.writeFile(
      path.join(projectDir, 'node_modules', 'next', 'setup-node-env.js'),
      ''
    );

    const launcherPath = path.join(projectDir, 'launcher.cjs');
    await fs.writeFile(
      launcherPath,
      getHandlerSource({
        projectRelativeDistDir: '.next',
        prerenderFallbackFalseMap,
        nextConfig: {},
      })
    );

    const launcher = require(launcherPath) as LauncherModule;

    return async function invoke(
      matchedPath: string
    ): Promise<{ entry: string; url: string; locale?: string }> {
      const response = {
        statusCode: 0,
        body: undefined as string | undefined,
        setHeader() {},
        end(body?: string) {
          this.body = body;
        },
      };

      await launcher(
        {
          url: '/requested',
          method: 'GET',
          headers: { host: 'example.test', 'x-matched-path': matchedPath },
        },
        response,
        {}
      );

      expect(response.statusCode).toBe(200);
      if (response.body === undefined) {
        throw new Error('The entry stub did not write a response body.');
      }
      return JSON.parse(response.body);
    };
  }

  it('requires the page that the matched path names', async () => {
    const invoke = await setupApp({
      entries: {
        '/about': 'app/about/page',
        '/api/hello': 'pages/api/hello',
        '/blog/[slug]': 'app/blog/[slug]/page',
      },
      dynamicRoutes: [BLOG],
    });

    expect((await invoke('/about')).entry).toBe('app/about/page');
    expect((await invoke('/about.rsc')).entry).toBe('app/about/page');
    expect((await invoke('/api/hello')).entry).toBe('pages/api/hello');
    // The route itself is not a path of the route: no captures are added.
    expect(await invoke('/blog/[slug]')).toMatchObject({
      entry: 'app/blog/[slug]/page',
      url: '/requested',
    });
  });

  it('matches a path against the dynamic routes in order', async () => {
    const invoke = await setupApp({
      entries: {
        '/blog/[slug]': 'app/blog/[slug]/page',
        '/[...all]': 'app/[...all]/page',
      },
      dynamicRoutes: [BLOG, CATCH_ALL],
    });

    expect(await invoke('/blog/hello')).toMatchObject({
      entry: 'app/blog/[slug]/page',
      url: '/requested?nxtPslug=hello',
    });
    expect(await invoke('/blog/hello/world')).toMatchObject({
      entry: 'app/[...all]/page',
      url: '/requested?nxtPall=blog%2Fhello%2Fworld',
    });
  });

  it('resolves /index to the page /', async () => {
    const invoke = await setupApp({
      entries: { '/': 'app/page', '/[...all]': 'app/[...all]/page' },
      dynamicRoutes: [CATCH_ALL],
    });

    expect(await invoke('/index')).toMatchObject({
      entry: 'app/page',
      url: '/requested',
    });
    expect((await invoke('/index.rsc')).entry).toBe('app/page');
    expect((await invoke('/')).entry).toBe('app/page');
  });

  it('matches a static route only by its exact page', async () => {
    const invoke = await setupApp({
      entries: { '/a.b': 'app/a.b/page', '/[...all]': 'app/[...all]/page' },
      dynamicRoutes: [CATCH_ALL],
    });

    expect((await invoke('/a.b')).entry).toBe('app/a.b/page');
    expect((await invoke('/aXb')).entry).toBe('app/[...all]/page');
    expect((await invoke('/a.b/c')).entry).toBe('app/[...all]/page');
  });

  it('skips a fallback: false route for a path that was not prerendered', async () => {
    const invoke = await setupApp({
      entries: {
        '/blog/[slug]': 'pages/blog/[slug]',
        '/[...all]': 'pages/[...all]',
      },
      dynamicRoutes: [BLOG, CATCH_ALL],
      i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
      prerenderFallbackFalseMap: {
        '/blog/[slug]': ['/blog/a', '/fr/blog/b'],
      },
    });

    expect((await invoke('/blog/a')).entry).toBe('pages/blog/[slug]');
    expect(await invoke('/fr/blog/b')).toMatchObject({
      entry: 'pages/blog/[slug]',
      locale: 'fr',
    });
    expect((await invoke('/blog/b')).entry).toBe('pages/[...all]');
    expect(await invoke('/fr/blog/zzz')).toMatchObject({
      entry: 'pages/[...all]',
      locale: 'fr',
    });
  });

  it('builds a RegExp only for a dynamic route that a request tests', async () => {
    let constructed = 0;
    globalThis.RegExp = new Proxy(OriginalRegExp, {
      construct(target, args: ConstructorParameters<RegExpConstructor>) {
        constructed++;
        return new target(...args);
      },
    });

    const invoke = await setupApp({
      entries: {
        '/': 'app/page',
        '/about': 'app/about/page',
        '/blog/[slug]': 'app/blog/[slug]/page',
        '/[...all]': 'app/[...all]/page',
      },
      dynamicRoutes: [BLOG, CATCH_ALL],
    });
    expect(constructed).toBe(0);

    await invoke('/about');
    await invoke('/blog/[slug]');
    expect(constructed).toBe(0);

    await invoke('/blog/hello');
    expect(constructed).toBe(1);

    await invoke('/blog/hello');
    await invoke('/other');
    expect(constructed).toBe(2);
  });
});
