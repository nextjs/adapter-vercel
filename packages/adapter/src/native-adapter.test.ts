import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageDir = path.resolve(__dirname, '..');
const { defaultConfig } = require('next/dist/server/config-shared');

async function tree(root: string) {
  const result: Record<string, unknown> = {};
  async function visit(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const name = path.relative(root, file);
      if (entry.isSymbolicLink())
        result[name] = { symlink: await fs.readlink(file) };
      else if (entry.isDirectory()) await visit(file);
      else {
        const content = await fs.readFile(file);
        result[name] = name.endsWith('.json')
          ? JSON.parse(content.toString('utf8'))
          : content;
      }
    }
  }
  await visit(root);
  return result;
}

describe('native adapter parity with the JavaScript adapter', () => {
  it.each([
    {
      basePath: '',
      trailingSlash: false,
      middleware: undefined,
      i18n: undefined,
    },
    {
      basePath: '/docs',
      trailingSlash: true,
      middleware: 'nodejs',
      i18n: undefined,
    },
    {
      basePath: '',
      trailingSlash: false,
      middleware: 'edge',
      i18n: {
        locales: ['en', 'de'],
        defaultLocale: 'en',
        domains: [
          { domain: 'example.de', defaultLocale: 'de', locales: ['en'] },
        ],
      },
    },
    {
      basePath: '/docs',
      trailingSlash: true,
      middleware: 'nodejs',
      i18n: {
        locales: ['en', 'de'],
        defaultLocale: 'en',
        localeDetection: false,
      },
    },
  ])(
    'matches functions, routing, fallbacks and static assets: %j',
    async ({ basePath, trailingSlash, middleware, i18n }) => {
      const projectDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'native-adapter-parity-')
      );
      const previous = process.env.NEXT_ADAPTER_VERCEL_CONFIG;
      process.env.NEXT_ADAPTER_VERCEL_CONFIG = JSON.stringify({
        functions: { 'app/**': { memory: 1024, maxDuration: 23 } },
      });
      try {
        await fs.symlink(
          path.join(packageDir, 'node_modules'),
          path.join(projectDir, 'node_modules')
        );
        const distDir = path.join(projectDir, '.next');
        const write = async (
          name: string,
          content = 'module.exports = {};'
        ) => {
          const file = path.join(projectDir, name);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, content);
          return file;
        };
        await write(
          'package.json',
          JSON.stringify({ name: 'parity-fixture', engines: { node: '22.x' } })
        );
        await write(
          '.next/routes-manifest.json',
          '{"version":3,"headers":[{"x":1}],"deploymentId":"random","dynamicRoutes":[],"staticRoutes":[]}'
        );
        const sourceDir = trailingSlash ? 'src/' : '';
        await write(`${sourceDir}app/blog/page.tsx`);
        await write(`${sourceDir}pages/404.tsx`);
        await write('public/robots.txt', 'Allow: /');
        await fs.writeFile(
          path.join(projectDir, 'public/binary.dat'),
          Buffer.from([0, 255, 254, 195, 40, 10])
        );
        await fs.symlink(
          'robots.txt',
          path.join(projectDir, 'public/robots-link.txt')
        );
        const output = async (
          id: string,
          type: string,
          pathname: string,
          runtime = 'nodejs',
          sourcePage = pathname
        ) => ({
          id,
          type,
          pathname: basePath + pathname,
          runtime,
          sourcePage,
          filePath: await write(`.next/server/${id}.js`),
          assets: {},
          assetsHashes: {},
          config: {} as Record<string, unknown>,
        });
        const page = await output(
          'blog',
          'APP_PAGE',
          '/blog',
          'nodejs',
          '/blog/page'
        );
        const pages404 = await output('404', 'PAGES', '/404', 'nodejs', '/404');
        const sharedAsset = await write('.next/server/shared.js');
        const pageAsset = await write('.next/server/page-only.js');
        const notFoundAsset = await write('.next/server/404-only.js');
        page.assets = { shared: sharedAsset, selected: pageAsset };
        page.assetsHashes = { shared: 'shared-hash', selected: 'page-hash' };
        pages404.assets = { shared: sharedAsset, selected: notFoundAsset };
        pages404.assetsHashes = { shared: 'shared-hash', selected: '404-hash' };
        const edge = await output(
          'edge',
          'PAGES_API',
          '/api/edge',
          'edge',
          '/api/edge'
        );
        const sourceMap = Buffer.from(
          JSON.stringify({ version: 3, sources: [], names: [], mappings: '' })
        ).toString('base64');
        const inlineAsset = await write(
          '.next/server/edge-inline.js',
          `globalThis.inline = true;\n\n//# sourceMappingURL=data:application/json;base64,${sourceMap}\n`
        );
        edge.assets = { 'edge-inline.js': inlineAsset };
        const staticFile = await write(
          '.next/static/chunks/main.js',
          'console.log("static")'
        );
        const html = await write(
          '.next/server/blog.html',
          '<html>shell</html>'
        );
        const middlewareOutput = middleware
          ? await output(
              'middleware',
              'MIDDLEWARE',
              '/middleware',
              middleware,
              'middleware'
            )
          : undefined;
        if (middlewareOutput)
          middlewareOutput.config = {
            matchers: [
              {
                sourceRegex: '^/.*$',
                source: '/:path*',
                has: [{ type: 'header', key: 'test' }],
              },
            ],
          };
        const rsc = {
          header: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
          prefetchSegmentDirSuffix: '.segments',
          prefetchSegmentSuffix: '.segment.rsc',
          varyHeader: 'rsc, next-router-state-tree',
          contentTypeHeader: 'text/x-component',
        };
        const ctx = {
          config: { ...defaultConfig, basePath, trailingSlash, i18n },
          projectDir,
          repoRoot: projectDir,
          distDir,
          nextVersion: '16.4.0-canary.38',
          buildId: 'build-test',
          routing: {
            beforeMiddleware: [
              { sourceRegex: '^/headers$', headers: { 'x-test': 'yes' } },
              {
                sourceRegex: '^/redirect$',
                status: 308,
                headers: { Location: '/blog' },
                priority: true,
              },
            ],
            beforeFiles: [
              {
                sourceRegex: '^/before(?:\\/)?$',
                destination: '/blog?keep=1&nxtPslug=secret',
              },
            ],
            afterFiles: [
              { sourceRegex: '^/after(?:\\/)?$', destination: '/blog?keep=1' },
            ],
            fallback: [
              {
                sourceRegex: '^/external$',
                destination: 'https://example.com/blog',
              },
            ],
            dynamicRoutes: [
              { sourceRegex: '^/blog/([^/]+)$', destination: '/blog/$1' },
            ],
            onMatch: [{ sourceRegex: '^/blog$', headers: { 'x-hit': 'yes' } }],
            shouldNormalizeNextData: Boolean(middleware),
            rsc,
          },
          outputs: {
            appPages: [page],
            appRoutes: [],
            pages: [pages404],
            pagesApi: [edge],
            middleware: middlewareOutput,
            staticFiles: [
              {
                id: 'chunk',
                type: 'STATIC_FILE',
                pathname: `${basePath}/_next/static/chunks/main.js`,
                filePath: staticFile,
                immutableHash: 'hash-static',
              },
            ],
            prerenders: [
              {
                id: 'html',
                type: 'PRERENDER',
                pathname: `${basePath}/blog/first`,
                parentOutputId: page.id,
                parentFallbackMode: false,
                groupId: 1,
                compute: 'static',
                htmlSize: 0,
                config: { allowQuery: [] },
                fallback: {
                  filePath: html,
                  postponedState: 'Doppelgänger',
                  initialStatus: 200,
                  initialHeaders: { 'content-type': 'text/html' },
                },
              },
              {
                id: 'rsc',
                type: 'PRERENDER',
                pathname: `${basePath}/blog/first.rsc`,
                parentOutputId: page.id,
                groupId: 1,
                config: { allowQuery: [] },
                fallback: { postponedState: 'Doppelgänger' },
                pprChain: { headers: { rsc: '1' } },
              },
            ],
          },
        };
        const goCtx = JSON.parse(JSON.stringify(ctx));
        const jsPath = require.resolve('../dist/index.js');
        delete require.cache[jsPath];
        await require(jsPath).onBuildComplete(ctx);
        const expected = await tree(path.join(distDir, 'output'));
        await fs.rm(path.join(distDir, 'output'), { recursive: true });
        await require('../dist/native-adapter.js').onBuildComplete(goCtx);
        expect(await tree(path.join(distDir, 'output'))).toEqual(expected);
      } finally {
        if (previous === undefined)
          delete process.env.NEXT_ADAPTER_VERCEL_CONFIG;
        else process.env.NEXT_ADAPTER_VERCEL_CONFIG = previous;
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    }
  );
});
