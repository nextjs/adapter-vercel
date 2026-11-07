import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { defaultConfig } = require('next/dist/server/config-shared');

it('uses the standard adapter entrypoint to package Node functions and assets natively', async () => {
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
    const filePath = path.join(distDir, 'server/health.js');
    await fs.writeFile(filePath, 'exports.GET = () => new Response("healthy")');
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
        staticFiles: [],
        prerenders: [],
      },
    });
    const output = JSON.parse(
      await fs.readFile(path.join(distDir, 'output/config.json'), 'utf8')
    );
    expect(output.version).toBe(3);
    expect(output.routes.length).toBeGreaterThan(0);
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
});
