import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { defaultConfig } = require('next/dist/server/config-shared');

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([undefined, '', '0', 'true', '1'])(
  'selects the adapter implementation only with explicit Go opt-in (%s)',
  async (enabled) => {
    vi.stubEnv('NEXT_USE_GO_BUILDER', enabled);
    if (enabled !== '1') {
      vi.stubEnv('NEXT_ADAPTER_GO_BINARY', '/missing/go-adapter-must-not-run');
    }
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adapter-entrypoint-')
    );
    try {
      await fs.symlink(
        path.resolve(__dirname, '../node_modules'),
        path.join(projectDir, 'node_modules'),
        'junction'
      );
      const distDir = path.join(projectDir, '.next');
      await fs.mkdir(path.join(distDir, 'server'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ engines: { node: '22.x' } })
      );
      await fs.writeFile(path.join(distDir, 'routes-manifest.json'), '{}');
      const shared = path.join(projectDir, 'shared-public');
      await fs.mkdir(shared);
      await fs.writeFile(path.join(shared, 'asset.txt'), 'shared asset');
      await fs.mkdir(path.join(projectDir, 'public'));
      await fs.symlink(
        shared,
        path.join(projectDir, 'public/shared'),
        'junction'
      );
      const staticPath = path.join(distDir, 'static/chunks/entry.js');
      await fs.mkdir(path.dirname(staticPath), { recursive: true });
      await fs.writeFile(staticPath, 'entry chunk');
      const filePath = path.join(distDir, 'server/health.js');
      await fs.writeFile(
        filePath,
        'exports.GET = () => new Response("healthy")'
      );
      const adapter = require('../dist/index.js');
      expect(adapter.name).toBe('Vercel');
      await adapter.onBuildComplete({
        projectDir,
        repoRoot: projectDir,
        distDir,
        buildId: 'entrypoint',
        nextVersion: '16.2.0',
        config: { ...defaultConfig },
        routing: {
          beforeMiddleware: [],
          beforeFiles: [],
          afterFiles: [],
          fallback: [],
          dynamicRoutes: [],
          onMatch: [],
          rsc: {
            header: 'rsc',
            contentTypeHeader: 'text/x-component',
            varyHeader: 'rsc',
            prefetchHeader: 'next-router-prefetch',
            prefetchSegmentHeader: 'next-router-segment-prefetch',
            prefetchSegmentDirSuffix: '.segments',
            prefetchSegmentSuffix: '.segment.rsc',
          },
        },
        outputs: {
          appPages: [],
          appRoutes: [
            {
              id: 'health',
              type: 'APP_ROUTE',
              runtime: 'nodejs',
              sourcePage: '/health/route',
              pathname: '/health',
              filePath,
              assets: {},
              assetsHashes: {},
              config: {},
            },
          ],
          pages: [],
          pagesApi: [],
          staticFiles: [
            {
              type: 'STATIC_FILE',
              filePath: staticPath,
              pathname: '/_next/static/chunks/entry.js',
            },
          ],
          prerenders: [],
        },
      });
      const output = JSON.parse(
        await fs.readFile(path.join(distDir, 'output/config.json'), 'utf8')
      );
      expect(output.version).toBe(3);
      expect(output.routes.length).toBeGreaterThan(0);
      const copiedLink = path.join(distDir, 'output/static/shared');
      expect((await fs.lstat(copiedLink)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(copiedLink)).toBe(await fs.realpath(shared));
      expect(
        await fs.readFile(path.join(copiedLink, 'asset.txt'), 'utf8')
      ).toBe('shared asset');
      const fn = JSON.parse(
        await fs.readFile(
          path.join(distDir, 'output/functions/health.func/.vc-config.json'),
          'utf8'
        )
      );
      expect(fn).toMatchObject({
        runtime: 'nodejs22.x',
        framework: { slug: 'nextjs', version: '16.2.0' },
        operationType: 'API',
        launcherType: 'Nodejs',
      });
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  }
);
