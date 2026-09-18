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
